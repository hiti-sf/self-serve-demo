import { slugify } from '@demo-platform/shared';
import { sendToBackground, type CaptureResult } from '../lib/messages.js';

/**
 * Popup: the author's capture + review surface.
 *
 * The redaction step is deliberately a decision, not a default: the tool flags
 * candidates and the author confirms (SPEC §5).
 */

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`popup is missing #${id}`);
  return node as T;
};

const captureButton = el<HTMLButtonElement>('capture');
const saveButton = el<HTMLButtonElement>('save');
const status = el<HTMLParagraphElement>('status');
const summary = el<HTMLElement>('summary');
const preview = el<HTMLImageElement>('preview');
const stats = el<HTMLDListElement>('stats');
const warnings = el<HTMLUListElement>('warnings');
const warningCount = el<HTMLSpanElement>('warning-count');
const piiBlock = el<HTMLElement>('pii-block');
const piiList = el<HTMLUListElement>('pii');
const piiAll = el<HTMLInputElement>('pii-all');
const folder = el<HTMLInputElement>('folder');

let current: CaptureResult | null = null;

/**
 * Host access (SPEC §5).
 *
 * `activeTab` covers reading the page the author invoked us on, but embedding its
 * cross-origin fonts, images and stylesheets means fetching from *other* origins in the
 * service worker, and that needs a real host permission. It is declared optional so
 * installing the extension does not demand access to every site up front — so it has to
 * be requested, once, from a user gesture. This click is that gesture.
 */
async function ensureHostAccess(): Promise<boolean> {
  const wanted: chrome.permissions.Permissions = { origins: ['<all_urls>'] };
  if (await chrome.permissions.contains(wanted)) return true;

  setStatus('Chrome is asking for access to page resources — this is needed to embed fonts and images.');
  try {
    return await chrome.permissions.request(wanted);
  } catch {
    return false;
  }
}

function setStatus(message: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  status.textContent = message;
  status.dataset.kind = kind;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderStats(result: CaptureResult): void {
  const { meta } = result;
  const rows: [string, string][] = [
    ['Page', meta.title || meta.url],
    ['Viewport', `${meta.viewport.width}×${meta.viewport.height} @${meta.viewport.devicePixelRatio}x`],
    ['Full page', `${meta.viewport.documentWidth}×${meta.viewport.documentHeight}`],
    ['Snapshot', formatBytes(meta.stats.snapshotBytes)],
    ['Embedded', `${meta.stats.embeddedResources} resource(s)`],
    ['Rasterised', `${meta.stats.rasterisedCanvases} canvas/frame region(s)`],
    ['Shadow roots', String(meta.stats.serialisedShadowRoots)],
    ['Took', `${(meta.stats.durationMs / 1000).toFixed(1)} s`],
  ];
  stats.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

function renderWarnings(result: CaptureResult): void {
  warningCount.textContent = String(result.meta.warnings.length);
  warnings.replaceChildren(
    ...result.meta.warnings.map((warning) => {
      const li = document.createElement('li');
      const kind = document.createElement('div');
      kind.className = 'pii-kind';
      kind.textContent = warning.kind.replace(/-/g, ' ');
      const detail = document.createElement('div');
      detail.textContent = warning.detail;
      li.append(kind, detail);
      return li;
    }),
  );
}

function renderPii(result: CaptureResult): void {
  piiBlock.hidden = result.piiFindings.length === 0;
  piiList.replaceChildren(
    ...result.piiFindings.map((finding) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'pii-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.value = finding.match;
      checkbox.dataset.role = 'pii';

      const text = document.createElement('div');
      const kind = document.createElement('div');
      kind.className = 'pii-kind';
      kind.textContent = finding.label;
      const match = document.createElement('div');
      match.className = 'pii-match';
      match.textContent = finding.match;
      const context = document.createElement('div');
      context.className = 'pii-context';
      context.textContent = finding.context;
      text.append(kind, match, context);

      label.append(checkbox, text);
      li.append(label);
      return li;
    }),
  );
}

function render(result: CaptureResult): void {
  current = result;
  summary.hidden = false;
  preview.src = result.fallbackPng;
  renderStats(result);
  renderWarnings(result);
  renderPii(result);
  if (!folder.value) folder.value = slugify(result.meta.title || 'capture', 'capture');
}

captureButton.addEventListener('click', async () => {
  captureButton.disabled = true;

  if (!(await ensureHostAccess())) {
    captureButton.disabled = false;
    setStatus(
      'Without access to page resources, fonts and images from other domains cannot be embedded ' +
        'and the snapshot will not render offline. Click capture again to grant it.',
      'error',
    );
    return;
  }

  setStatus('Screenshotting the page, then serialising the DOM…');
  const response = await sendToBackground<CaptureResult>({ type: 'capture/start' });
  captureButton.disabled = false;

  if (!response.ok) {
    setStatus(response.error, 'error');
    return;
  }
  render(response.data);
  setStatus(
    response.data.piiFindings.length > 0
      ? `Captured. ${response.data.piiFindings.length} value(s) need a PII decision.`
      : 'Captured. No PII candidates found.',
    'ok',
  );
});

piiAll.addEventListener('change', () => {
  for (const input of piiList.querySelectorAll<HTMLInputElement>('input[data-role="pii"]')) {
    input.checked = piiAll.checked;
  }
});

saveButton.addEventListener('click', async () => {
  if (!current) return;
  const redactions = [...piiList.querySelectorAll<HTMLInputElement>('input[data-role="pii"]')]
    .filter((input) => input.checked)
    .map((input) => input.value);

  saveButton.disabled = true;
  setStatus('Writing snapshot.html, fallback.png and capture-meta.json…');
  const response = await sendToBackground<{ folder: string }>({
    type: 'capture/save',
    captureId: current.meta.captureId,
    redactions,
    folder: folder.value,
  });
  saveButton.disabled = false;

  setStatus(response.ok ? `Saved to ${response.data.folder}/` : response.error, response.ok ? 'ok' : 'error');
});

// Re-opening the popup should not lose a capture the author has not saved yet.
void (async () => {
  const response = await sendToBackground<CaptureResult | null>({ type: 'capture/get-last' });
  if (response.ok && response.data) {
    render(response.data);
    setStatus('Showing your last unsaved capture.', 'info');
  }
})();
