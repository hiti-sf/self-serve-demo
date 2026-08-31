import { assertScriptFree } from '@demo-platform/shared';
import { fallbackPath, snapshotPath, toManifest, type EditorProject } from '../state/project.js';

/**
 * Export and publish (SPEC §7).
 *
 * "Export" produces exactly the demo folder the player loads — manifest, snapshots,
 * fallback images, assets — so what an author downloads is the same thing publish writes.
 * There is no separate export format to drift.
 */

export interface DemoFile {
  path: string;
  /** Text files carry `text`; binaries carry `base64`. */
  text?: string;
  base64?: string;
  contentType: string;
}

export interface BuiltDemo {
  ok: true;
  folder: string;
  files: DemoFile[];
}

export interface BuildProblems {
  ok: false;
  issues: string[];
}

/** Split a data: URL into its media type and base64 payload. */
export function decodeDataUrl(dataUrl: string): { contentType: string; base64: string } | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const [, contentType, isBase64, payload] = match;
  if (!contentType || payload === undefined) return null;
  if (isBase64) return { contentType, base64: payload };
  // Percent-encoded payload: re-encode so callers only deal with base64.
  const text = decodeURIComponent(payload);
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { contentType, base64: btoa(binary) };
}

/**
 * Build the demo folder. Validation runs first: an invalid manifest must never reach
 * `demos/`, because everything downstream — the player, both build targets, the repo
 * validator — assumes what is there is playable.
 */
export function buildDemoFiles(project: EditorProject): BuiltDemo | BuildProblems {
  const manifestResult = toManifest(project);
  if (!manifestResult.ok) return { ok: false, issues: manifestResult.issues };

  const issues: string[] = [];
  const files: DemoFile[] = [
    {
      path: 'manifest.json',
      text: `${JSON.stringify(manifestResult.manifest, null, 2)}\n`,
      contentType: 'application/json',
    },
  ];

  for (const step of project.steps) {
    try {
      assertScriptFree(step.snapshotHtml);
    } catch (error) {
      issues.push(`${step.stepId}: ${(error as Error).message}`);
      continue;
    }

    files.push({
      path: snapshotPath(step.stepId),
      text: step.snapshotHtml.endsWith('\n') ? step.snapshotHtml : `${step.snapshotHtml}\n`,
      contentType: 'text/html',
    });

    const image = decodeDataUrl(step.fallbackImage);
    if (!image) {
      issues.push(`${step.stepId}: the fallback image could not be decoded.`);
      continue;
    }
    files.push({
      path: fallbackPath(step.stepId),
      base64: image.base64,
      contentType: image.contentType,
    });
  }

  for (const asset of project.assets) {
    const decoded = decodeDataUrl(asset.dataUrl);
    if (!decoded) {
      issues.push(`asset ${asset.path} could not be decoded.`);
      continue;
    }
    files.push({ path: asset.path, base64: decoded.base64, contentType: decoded.contentType });
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    folder: `${project.product.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${project.demoId}`,
    files,
  };
}

/** Download the demo folder as a zip. Browser-only; JSZip is loaded lazily. */
export async function downloadDemoZip(project: EditorProject): Promise<{ ok: boolean; issues?: string[] }> {
  const built = buildDemoFiles(project);
  if (!built.ok) return { ok: false, issues: built.issues };

  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const root = zip.folder(project.demoId) ?? zip;

  for (const file of built.files) {
    if (file.text !== undefined) root.file(file.path, file.text);
    else if (file.base64 !== undefined) root.file(file.path, file.base64, { base64: true });
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${project.demoId}.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
  return { ok: true };
}

export interface PublishResult {
  ok: boolean;
  folder?: string;
  written?: number;
  error?: string;
  issues?: string[];
}

/**
 * One-click publish: POST the built folder to the internal publish server, which writes
 * it into `demos/` (§7). The password travels in a header and never in a query string or
 * the URL bar.
 */
export async function publishDemo(
  project: EditorProject,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  const built = buildDemoFiles(project);
  if (!built.ok) return { ok: false, issues: built.issues };

  try {
    const response = await fetchImpl('/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-editor-token': token },
      body: JSON.stringify({
        demoId: project.demoId,
        product: project.product,
        files: built.files,
      }),
    });
    const body = (await response.json()) as PublishResult;
    if (!response.ok) return { ok: false, error: body.error ?? `publish failed (${response.status})` };
    // The server's own `ok` is authoritative; spreading it last keeps that true.
    return { ...body, ok: body.ok !== false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Draft persistence, so a browser refresh mid-authoring is not a lost afternoon. */
const DRAFT_KEY = 'demo-editor:draft';

export function saveDraft(project: EditorProject): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(project));
  } catch {
    /* quota or private mode: the author still has Export */
  }
}

export function loadDraft(): EditorProject | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as EditorProject) : null;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}
