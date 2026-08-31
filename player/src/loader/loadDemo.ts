import {
  ManifestValidationError,
  SchemaVersionError,
  parseManifest,
  type Manifest,
} from '@demo-platform/shared';

/**
 * Demo loading (SPEC §6). A demo folder is `manifest.json` plus `snapshots/` and
 * `assets/`, so every path in the manifest resolves relative to the folder — the same
 * folder works served from a web route or from a kiosk bundle on a USB stick.
 */

export interface DemoBundle {
  manifest: Manifest;
  /** Absolute URL for a manifest-relative path. */
  resolve: (relativePath: string) => string;
  baseUrl: string;
}

export class DemoLoadError extends Error {
  readonly detail: string[];

  constructor(message: string, detail: string[] = []) {
    super(message);
    this.name = 'DemoLoadError';
    this.detail = detail;
  }
}

function joinUrl(baseUrl: string, relativePath: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath, new URL(base, globalThis.location?.href ?? 'http://localhost/')).toString();
}

export async function loadDemo(
  baseUrl: string,
  { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {},
): Promise<DemoBundle> {
  const manifestUrl = joinUrl(baseUrl, 'manifest.json');
  let raw: unknown;
  try {
    const response = await fetchImpl(manifestUrl);
    if (!response.ok) {
      throw new DemoLoadError(`Could not load the demo (${response.status} from ${manifestUrl}).`);
    }
    raw = await response.json();
  } catch (error) {
    if (error instanceof DemoLoadError) throw error;
    throw new DemoLoadError('Could not load the demo manifest.', [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  try {
    const manifest = parseManifest(raw, manifestUrl);
    return { manifest, baseUrl, resolve: (path) => joinUrl(baseUrl, path) };
  } catch (error) {
    if (error instanceof SchemaVersionError) {
      // Surfaced verbatim: it tells the operator exactly what to update (§4).
      throw new DemoLoadError(error.message);
    }
    if (error instanceof ManifestValidationError) {
      throw new DemoLoadError('This demo manifest is not valid.', error.issues);
    }
    throw error;
  }
}

/**
 * Fetch a snapshot's HTML for `srcdoc` rendering. Returning null (rather than throwing)
 * puts the step on the fallback-image path, which is exactly what §4 asks for.
 */
export async function loadSnapshotHtml(
  url: string,
  { fetchImpl = fetch, timeoutMs = 10_000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return null;
    const html = await response.text();
    return html.trim().length > 0 ? html : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
