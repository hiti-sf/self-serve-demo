import { CAPTURE_FILE_NAMES, CaptureMetaSchema, randomId, slugify, type CaptureMeta } from '@demo-platform/shared';
import { sliceOffsets } from '../lib/crop.js';
import { fail, ok, type CaptureResult, type ConvertedCapture, type Message, type PageMetrics, type RawCapture, type Response } from '../lib/messages.js';

/**
 * Service worker: orchestrates the capture and owns the two privileged capabilities —
 * screenshots of the visible tab, and fetches that are not subject to the page's CORS
 * policy (so cross-origin fonts and images can still be embedded, SPEC §5).
 */

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const CAPTURED_BY = `capture-extension@${EXTENSION_VERSION}`;

/** chrome.tabs.captureVisibleTab is rate-limited to roughly two calls per second. */
const SCREENSHOT_INTERVAL_MS = 600;
/** A demo screen taller than this is a scrolling essay, not a step. */
const MAX_SCREENSHOT_SLICES = 12;
const MAX_FETCH_BYTES = 8 * 1024 * 1024;

interface StoredCapture {
  result: CaptureResult;
  createdAt: number;
}

let lastCapture: StoredCapture | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function activeTab(explicitTabId?: number): Promise<chrome.tabs.Tab> {
  if (explicitTabId !== undefined) {
    return chrome.tabs.get(explicitTabId);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab to capture');
  return tab;
}

async function sendToTab<T>(tabId: number, message: Message): Promise<T> {
  const response = (await chrome.tabs.sendMessage(tabId, message)) as Response<T>;
  if (!response?.ok) throw new Error(response?.error ?? 'content script did not respond');
  return response.data;
}

/** Inject the content script on demand: the extension declares no automatic matches. */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await sendToTab<PageMetrics>(tabId, { type: 'content/metrics' });
    return;
  } catch {
    /* not injected yet */
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/capture.js'],
  });
}

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts?.({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  if (existing && existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['DOM_PARSER' as chrome.offscreen.Reason, 'BLOBS' as chrome.offscreen.Reason],
    justification:
      'Rebuild the captured DOM into a sandboxed iframe and stitch page screenshots for the offline fallback image.',
  });
}

async function sendToOffscreen<T>(message: unknown): Promise<T> {
  await ensureOffscreen();
  const response = (await chrome.runtime.sendMessage(message)) as Response<T>;
  if (!response?.ok) throw new Error(response?.error ?? 'offscreen document did not respond');
  return response.data;
}

/**
 * Full-page fallback PNG (§5): scroll the page one viewport at a time, screenshot each
 * slice, and stitch them in the offscreen document. The page's scroll position is
 * restored afterwards — the author is working in a live system.
 */
async function captureFullPagePng(tab: chrome.tabs.Tab, metrics: PageMetrics): Promise<string> {
  const tabId = tab.id!;
  const { viewport } = metrics;
  const offsets = sliceOffsets(viewport.documentHeight, viewport.height).slice(0, MAX_SCREENSHOT_SLICES);
  const slices: { dataUrl: string; y: number }[] = [];

  for (const [index, y] of offsets.entries()) {
    await sendToTab(tabId, { type: 'content/scroll-to', y });
    if (index > 0) await delay(SCREENSHOT_INTERVAL_MS);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    slices.push({ dataUrl, y });
  }

  await sendToTab(tabId, { type: 'content/restore-scroll', y: viewport.scrollY });

  const stitchedHeight = Math.min(
    viewport.documentHeight,
    (offsets[offsets.length - 1] ?? 0) + viewport.height,
  );

  return sendToOffscreen<string>({
    type: 'offscreen/stitch',
    slices,
    width: viewport.width,
    height: stitchedHeight,
    devicePixelRatio: viewport.devicePixelRatio,
  });
}

function buildMeta(
  raw: RawCapture,
  converted: ConvertedCapture,
  html: string,
  durationMs: number,
): CaptureMeta {
  const strippedScripts = converted.warnings.filter((w) => w.detail.includes('script element')).length;
  return CaptureMetaSchema.parse({
    captureId: raw.captureId,
    url: raw.url,
    title: raw.title,
    timestamp: raw.timestamp,
    viewport: raw.viewport,
    stats: {
      snapshotBytes: new TextEncoder().encode(html).length,
      embeddedResources: converted.embeddedResources,
      strippedScripts,
      strippedEventHandlers: raw.stats.strippedEventHandlers,
      rasterisedCanvases: raw.stats.rasterisedCanvases,
      serialisedShadowRoots: raw.stats.serialisedShadowRoots,
      durationMs,
    },
    warnings: converted.warnings,
    anchorHints: raw.anchorHints,
    sanitised: false,
    capturedBy: CAPTURED_BY,
  });
}

/**
 * Cross-origin embedding runs through this worker's privileged fetch, which needs a
 * host permission. Without it every external font, image and stylesheet is dropped and
 * the snapshot renders incomplete offline — a failure that is invisible until a
 * tradeshow. Fail loudly instead.
 */
async function assertHostAccess(): Promise<void> {
  const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  if (!granted) {
    throw new Error(
      'This extension has not been granted access to page resources, so fonts and images from ' +
        'other domains cannot be embedded. Open the extension and click capture again to grant it.',
    );
  }
}

async function runCapture(explicitTabId?: number): Promise<CaptureResult> {
  const startedAt = Date.now();
  await assertHostAccess();
  const tab = await activeTab(explicitTabId);
  const tabId = tab.id!;
  const url = tab.url ?? '';

  if (/^(?:chrome|edge|about|chrome-extension|devtools):/i.test(url)) {
    throw new Error('Browser-internal pages cannot be captured. Open the product page first.');
  }

  await ensureContentScript(tabId);
  const metrics = await sendToTab<PageMetrics>(tabId, { type: 'content/metrics' });

  // Screenshot first: the crop regions for canvas and cross-origin frames must come
  // from the untouched page, before the DOM pre-pass swaps them for placeholders.
  const fallbackPng = await captureFullPagePng(tab, metrics);

  const captureId = `cap_${randomId(12)}`;
  const raw = await sendToTab<RawCapture>(tabId, { type: 'content/capture', captureId });

  const converted = await sendToOffscreen<ConvertedCapture>({
    type: 'offscreen/convert',
    raw,
    fallbackPng,
  });

  const meta = buildMeta(raw, converted, converted.html, Date.now() - startedAt);
  const result: CaptureResult = {
    meta,
    html: converted.html,
    fallbackPng,
    piiFindings: converted.piiFindings,
  };

  lastCapture = { result, createdAt: Date.now() };
  return result;
}

/**
 * Privileged fetch for the embedder. Host permissions let the worker read
 * cross-origin fonts and images that the page itself could not.
 */
async function fetchResource(url: string): Promise<{ dataUrl: string; bytes: number; contentType: string } | null> {
  if (!/^https?:/i.test(url)) return null;
  try {
    const response = await fetch(url, { credentials: 'omit', redirect: 'follow' });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size > MAX_FETCH_BYTES) return null;
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buffer.length; i += 1) binary += String.fromCharCode(buffer[i]!);
    const contentType = blob.type || response.headers.get('content-type') || 'application/octet-stream';
    return {
      dataUrl: `data:${contentType};base64,${btoa(binary)}`,
      bytes: blob.size,
      contentType,
    };
  } catch {
    return null;
  }
}

async function saveCapture(captureId: string, redactions: string[], folder: string): Promise<{ folder: string }> {
  if (!lastCapture || lastCapture.result.meta.captureId !== captureId) {
    throw new Error('That capture is no longer in memory. Capture the step again.');
  }

  let html = lastCapture.result.html;
  if (redactions.length > 0) {
    const redacted = await sendToOffscreen<{ html: string; changed: number }>({
      type: 'offscreen/redact',
      html,
      matches: redactions,
    });
    html = redacted.html;
  }

  const meta: CaptureMeta = {
    ...lastCapture.result.meta,
    sanitised: true,
    warnings: [
      ...lastCapture.result.meta.warnings,
      ...(redactions.length > 0
        ? ([{ kind: 'pii-redacted', detail: `Author redacted ${redactions.length} value(s).` }] as const)
        : []),
    ],
  };

  const safeFolder = slugify(folder || lastCapture.result.meta.title || 'capture', 'capture');
  const base = `demo-captures/${safeFolder}-${captureId}`;

  await download(`${base}/${CAPTURE_FILE_NAMES.snapshot}`, textDataUrl(html, 'text/html'));
  await download(`${base}/${CAPTURE_FILE_NAMES.fallback}`, lastCapture.result.fallbackPng);
  await download(
    `${base}/${CAPTURE_FILE_NAMES.meta}`,
    textDataUrl(JSON.stringify(meta, null, 2), 'application/json'),
  );

  return { folder: base };
}

function textDataUrl(text: string, mime: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return `data:${mime};base64,${btoa(binary)}`;
}

async function download(filename: string, url: string): Promise<void> {
  await chrome.downloads.download({ url, filename, saveAs: false });
}

chrome.runtime.onMessage.addListener(
  (
    message: Message | { type: 'worker/fetch'; url: string },
    _sender,
    sendResponse: (response: Response<unknown>) => void,
  ) => {
    switch (message.type) {
      case 'capture/start':
        runCapture(message.tabId)
          .then((result) => sendResponse(ok(result)))
          .catch((error) => sendResponse(fail(error)));
        return true;

      case 'capture/save':
        saveCapture(message.captureId, message.redactions, message.folder)
          .then((result) => sendResponse(ok(result)))
          .catch((error) => sendResponse(fail(error)));
        return true;

      case 'capture/get-last':
        sendResponse(ok(lastCapture?.result ?? null));
        return false;

      case 'worker/fetch':
        fetchResource(message.url)
          .then((resource) => sendResponse(ok(resource)))
          .catch(() => sendResponse(ok(null)));
        return true;

      default:
        return false;
    }
  },
);
