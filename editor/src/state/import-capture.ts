import {
  CAPTURE_FILE_NAMES,
  assertScriptFree,
  safeParseCaptureMeta,
  type CaptureMeta,
} from '@demo-platform/shared';
import type { EditorStep } from './project.js';

/**
 * Import a capture trio as a new step (SPEC §7).
 *
 * The extension emits `snapshot.html`, `fallback.png` and `capture-meta.json`. The author
 * drops the folder (or the three files) on the editor and gets a step.
 *
 * The snapshot is re-checked here rather than trusted: a capture could have come from an
 * older extension build, or been hand-edited on the way in, and a snapshot with a script
 * in it must never reach a demo folder (§11).
 */

export interface CaptureFiles {
  snapshotHtml: string;
  /** data: URL of the fallback PNG. */
  fallbackImage: string;
  /** Raw capture-meta.json contents, if present. */
  metaJson?: string;
}

export interface ImportResult {
  ok: true;
  step: Omit<EditorStep, 'stepId' | 'chapterId'>;
  warnings: string[];
}

export interface ImportFailure {
  ok: false;
  errors: string[];
}

const VIEWPORT_ATTRIBUTE = /data-demo-viewport="(\d+)x(\d+)"/;

export function importCapture(files: CaptureFiles): ImportResult | ImportFailure {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!files.snapshotHtml?.trim()) {
    errors.push('snapshot.html is empty or missing.');
  }
  if (!files.fallbackImage) {
    // §4 makes the fallback image mandatory: without it a snapshot that fails to render
    // leaves a blank step in front of a prospect.
    errors.push('fallback.png is missing. Every step needs a fallback image.');
  } else if (!files.fallbackImage.startsWith('data:image/')) {
    errors.push('fallback.png did not import as an image.');
  }

  if (errors.length > 0) return { ok: false, errors };

  try {
    assertScriptFree(files.snapshotHtml);
  } catch (error) {
    errors.push(
      `${(error as Error).message}. Re-capture this screen with the current extension build rather than editing it by hand.`,
    );
    return { ok: false, errors };
  }

  let meta: CaptureMeta | undefined;
  if (files.metaJson) {
    try {
      const parsed = safeParseCaptureMeta(JSON.parse(files.metaJson));
      if (parsed.ok) meta = parsed.meta;
      else warnings.push(`${CAPTURE_FILE_NAMES.meta} could not be read (${parsed.issues[0]}); importing without it.`);
    } catch {
      warnings.push(`${CAPTURE_FILE_NAMES.meta} is not valid JSON; importing without it.`);
    }
  } else {
    warnings.push('No capture-meta.json — anchor hints and capture warnings are unavailable for this step.');
  }

  const viewport = resolveViewport(files.snapshotHtml, meta);

  if (meta) {
    if (!meta.sanitised) {
      warnings.push('This capture was saved without confirming the PII review. Check the content before publishing.');
    }
    for (const warning of meta.warnings) {
      if (warning.kind === 'pii-detected') {
        warnings.push(`Capture reported possible personal data: ${warning.detail}`);
      } else if (warning.kind === 'cross-origin-iframe' || warning.kind === 'shadow-root-closed') {
        warnings.push(`${warning.kind.replace(/-/g, ' ')}: ${warning.detail}`);
      }
    }
  }

  return {
    ok: true,
    warnings,
    step: {
      snapshotHtml: files.snapshotHtml,
      fallbackImage: files.fallbackImage,
      viewport,
      hotspots: [],
      ...(meta ? { captureMeta: meta } : {}),
      ...(meta?.title ? { notes: `Captured from ${meta.url}` } : {}),
    },
  };
}

/**
 * Prefer the capture's recorded viewport; fall back to the attribute the serialiser
 * stamps on the document, then to the platform default.
 */
function resolveViewport(html: string, meta?: CaptureMeta): { width: number; height: number } {
  if (meta?.viewport) return { width: meta.viewport.width, height: meta.viewport.height };
  const match = VIEWPORT_ATTRIBUTE.exec(html);
  if (match) return { width: Number(match[1]), height: Number(match[2]) };
  return { width: 1440, height: 900 };
}

/**
 * Sort a dropped file list into the capture trio. Accepts a whole folder drop, so the
 * author does not have to pick three files in the right order.
 */
export function groupCaptureFiles(names: string[]): { snapshot?: string; fallback?: string; meta?: string } {
  const find = (predicate: (name: string) => boolean) => names.find((name) => predicate(name.toLowerCase()));
  return {
    snapshot: find((name) => name.endsWith('.html')),
    fallback: find((name) => name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg')),
    meta: find((name) => name.endsWith('.json')),
  };
}
