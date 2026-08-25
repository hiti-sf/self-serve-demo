import { createCache, createMirror, rebuildIntoSandboxedIframe } from 'rrweb-snapshot';
import type { CaptureWarning } from '@demo-platform/shared';
import { embedResources, type FetchedResource } from '../lib/embed.js';
import { sanitiseDocument } from '../lib/sanitise.js';
import { flattenShadowRoots } from '../lib/shadow.js';
import {
  applyRedactions,
  scanDocumentForPii,
  serialiseDocument,
  type DocumentPiiFinding,
} from '../lib/serialise.js';
import { toPixelRect } from '../lib/crop.js';
import { findExternalUrlsInHtml } from '../lib/urls.js';
import { fail, ok, type ConvertedCapture, type Message, type RawCapture, type Response } from '../lib/messages.js';

/**
 * Offscreen document: turns the captured tree into a self-contained, script-free
 * HTML document (SPEC §5).
 *
 * Pipeline order matters:
 *   rebuild → flatten shadow roots → sanitise → embed → paste crops → CSP + serialise → PII
 * Shadow roots become declarative <template>s first, because `outerHTML` cannot
 * serialise a live shadow root and every later pass already descends into templates.
 * Sanitising before embedding means we never fetch a resource for an element that is
 * about to be removed; the CSP is added last because sanitise strips existing ones.
 */

const REBUILD_ROOT_ID = 'rebuild-root';

async function fetchThroughWorker(url: string): Promise<FetchedResource | null> {
  const response = (await chrome.runtime.sendMessage({
    type: 'worker/fetch',
    url,
  })) as Response<FetchedResource | null>;
  if (!response?.ok) return null;
  return response.data;
}

function rebuildDocument(tree: unknown): { doc: Document; dispose: () => void } {
  const root = document.getElementById(REBUILD_ROOT_ID);
  if (!root) throw new Error('offscreen document is missing its rebuild root');

  const { iframe } = rebuildIntoSandboxedIframe(tree as never, {
    root,
    cache: createCache(),
    // The mirror maps rrweb node ids to rebuilt nodes. We do not replay events, but
    // rebuild requires one.
    mirror: createMirror(),
    // hackCss rewrites :hover into class-based rules for replay. A demo snapshot is a
    // still frame, so leave the original CSS alone.
    hackCss: false,
  });

  const doc = iframe.contentDocument;
  if (!doc) throw new Error('rebuild produced no document — the sandboxed iframe did not initialise');

  return {
    doc,
    dispose: () => iframe.remove(),
  };
}

async function pasteCrops(
  doc: Document,
  raw: RawCapture,
  fallbackPng: string,
): Promise<CaptureWarning[]> {
  const warnings: CaptureWarning[] = [];
  const placeholders = Array.from(doc.querySelectorAll('img[data-demo-crop]'));
  if (placeholders.length === 0 || raw.cropRequests.length === 0) return warnings;

  const bitmap = await createImageBitmap(await (await fetch(fallbackPng)).blob());
  const bounds = { width: bitmap.width, height: bitmap.height };

  for (const request of raw.cropRequests) {
    const placeholder = doc.querySelector(`img[data-demo-crop="${request.cropId}"]`);
    if (!placeholder) continue;
    const rect = toPixelRect(request, raw.viewport.devicePixelRatio, bounds);
    if (!rect) {
      placeholder.remove();
      continue;
    }
    const canvas = new OffscreenCanvas(rect.width, rect.height);
    const context = canvas.getContext('2d');
    if (!context) continue;
    context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    placeholder.setAttribute('src', await blobToDataUrl(blob));
    placeholder.setAttribute('data-demo-replaced', request.reason);
    warnings.push({
      kind: request.reason === 'cross-origin-iframe' ? 'cross-origin-iframe' : 'canvas-rasterised',
      detail: `Pasted a ${rect.width}×${rect.height} screenshot region in place of a ${request.reason.replace('-', ' ')}.`,
    });
  }

  bitmap.close();
  return warnings;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('could not read blob'));
    reader.readAsDataURL(blob);
  });
}

async function convert(raw: RawCapture, fallbackPng: string): Promise<ConvertedCapture> {
  const { doc, dispose } = rebuildDocument(raw.tree);
  try {
    const flattened = flattenShadowRoots(doc);

    const sanitised = sanitiseDocument(doc);

    const embedded = await embedResources(doc, {
      baseUrl: raw.url,
      fetchResource: fetchThroughWorker,
    });

    const cropWarnings = await pasteCrops(doc, raw, fallbackPng);

    const html = serialiseDocument(doc, {
      captureId: raw.captureId,
      sourceUrl: raw.url,
      capturedAt: raw.timestamp,
      viewportWidth: raw.viewport.width,
      viewportHeight: raw.viewport.height,
      documentWidth: raw.viewport.documentWidth,
      documentHeight: raw.viewport.documentHeight,
    });

    const warnings: CaptureWarning[] = [
      ...raw.warnings,
      ...flattened.warnings,
      ...sanitised.warnings,
      ...embedded.warnings,
      ...cropWarnings,
    ];

    // Final offline gate: anything left here would hit the network at render time,
    // which breaks the kiosk guarantee (§8.2).
    const leftover = findExternalUrlsInHtml(html);
    if (leftover.length > 0) {
      warnings.push({
        kind: 'resource-fetch-failed',
        detail: `${leftover.length} external URL(s) survived embedding and will not load offline: ${leftover
          .slice(0, 5)
          .join(', ')}`,
      });
    }

    const piiFindings: DocumentPiiFinding[] = scanDocumentForPii(doc);
    if (piiFindings.length > 0) {
      warnings.push({
        kind: 'pii-detected',
        detail: `${piiFindings.length} possible PII value(s) found. Review before publishing.`,
      });
    }

    return {
      captureId: raw.captureId,
      html,
      piiFindings,
      warnings,
      embeddedResources: embedded.embedded,
    };
  } finally {
    dispose();
  }
}

/**
 * Re-apply the author's redactions to an already-converted snapshot. Parsing the HTML
 * back into a document (rather than string-replacing) keeps attribute and text-node
 * handling identical to the first pass.
 */
function redact(html: string, matches: string[]): { html: string; changed: number } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const changed = applyRedactions(doc, matches);
  return { html: `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`, changed };
}

async function stitch(
  slices: { dataUrl: string; y: number }[],
  width: number,
  height: number,
  devicePixelRatio: number,
): Promise<string> {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const canvas = new OffscreenCanvas(Math.round(width * ratio), Math.round(height * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('OffscreenCanvas 2d context unavailable');

  for (const slice of slices) {
    const bitmap = await createImageBitmap(await (await fetch(slice.dataUrl)).blob());
    context.drawImage(bitmap, 0, Math.round(slice.y * ratio));
    bitmap.close();
  }

  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
}

chrome.runtime.onMessage.addListener(
  (
    message: Message | { type: 'offscreen/redact'; html: string; matches: string[] },
    _sender,
    sendResponse: (response: Response<unknown>) => void,
  ) => {
    switch (message.type) {
      case 'offscreen/convert':
        convert(message.raw, message.fallbackPng)
          .then((result) => sendResponse(ok(result)))
          .catch((error) => sendResponse(fail(error)));
        return true;

      case 'offscreen/stitch':
        stitch(message.slices, message.width, message.height, message.devicePixelRatio)
          .then((dataUrl) => sendResponse(ok(dataUrl)))
          .catch((error) => sendResponse(fail(error)));
        return true;

      case 'offscreen/redact':
        try {
          sendResponse(ok(redact(message.html, message.matches)));
        } catch (error) {
          sendResponse(fail(error));
        }
        return false;

      default:
        return false;
    }
  },
);
