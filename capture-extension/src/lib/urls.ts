/**
 * URL classification and CSS url() rewriting.
 *
 * A snapshot must render identically with zero network access (SPEC §5). Everything
 * here is pure string work so it can be unit-tested without a browser — the fetching
 * itself lives in the service worker.
 */

/** Schemes that are already self-contained. */
const INLINE_SCHEMES = ['data:', 'blob:', 'about:', 'chrome-extension:'];

export function isInlineUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  return INLINE_SCHEMES.some((scheme) => trimmed.startsWith(scheme));
}

/** A fragment-only reference stays inside the document. */
export function isFragmentUrl(url: string): boolean {
  return url.trim().startsWith('#');
}

/**
 * True when this URL would cause a network request at render time and therefore must
 * be embedded (or removed) before the snapshot ships.
 */
export function isExternalUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  if (isFragmentUrl(trimmed) || isInlineUrl(trimmed)) return false;
  return true;
}

export function resolveUrl(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

const CSS_URL_RE = /url\(\s*(?:(['"])([^'"]*?)\1|([^'")\s][^)]*?))\s*\)/gi;

export interface CssUrlRef {
  /** The raw url as written in the CSS. */
  raw: string;
  /** Absolute URL, resolved against the stylesheet's own href. */
  absolute: string;
}

/** Every url() reference in a stylesheet, excluding ones already self-contained. */
export function extractCssUrls(cssText: string, baseUrl: string): CssUrlRef[] {
  const refs: CssUrlRef[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  const regex = new RegExp(CSS_URL_RE.source, CSS_URL_RE.flags);
  while ((match = regex.exec(cssText)) !== null) {
    const raw = (match[2] ?? match[3] ?? '').trim();
    if (!raw || !isExternalUrl(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    refs.push({ raw, absolute: resolveUrl(raw, baseUrl) });
  }
  return refs;
}

/** Replace url() references using a raw-url → data-URI map. Unresolved refs are neutralised. */
export function rewriteCssUrls(
  cssText: string,
  replacements: ReadonlyMap<string, string>,
  { neutraliseMissing = true }: { neutraliseMissing?: boolean } = {},
): string {
  const regex = new RegExp(CSS_URL_RE.source, CSS_URL_RE.flags);
  return cssText.replace(regex, (whole, _quote, quoted, bare) => {
    const raw = String(quoted ?? bare ?? '').trim();
    if (!raw || !isExternalUrl(raw)) return whole;
    const replacement = replacements.get(raw);
    if (replacement) return `url("${replacement}")`;
    // A url() we could not embed would hit the network at render time. An empty
    // reference degrades to "no background image", which is what we want offline.
    return neutraliseMissing ? 'url("")' : whole;
  });
}

/**
 * @import rules cannot be embedded as data URIs reliably across engines, and a
 * surviving one is a network dependency. They are inlined upstream (the browser
 * exposes imported rules via cssRules), so any left here is dropped.
 */
export function stripCssImports(cssText: string): string {
  return cssText.replace(/@import\s+[^;]+;/gi, '');
}

/** srcset is a comma-separated list of "url descriptor" pairs. */
export function parseSrcset(value: string): { url: string; descriptor: string }[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [url, ...rest] = part.split(/\s+/);
      return { url: url ?? '', descriptor: rest.join(' ') };
    })
    .filter((entry) => entry.url.length > 0);
}

export function serialiseSrcset(entries: { url: string; descriptor: string }[]): string {
  return entries.map((e) => (e.descriptor ? `${e.url} ${e.descriptor}` : e.url)).join(', ');
}

/**
 * Find every URL in a serialised document that would reach the network.
 * Used as the final gate before a snapshot is written, and by the kiosk build lint.
 */
export function findExternalUrlsInHtml(html: string): string[] {
  const found = new Set<string>();
  const attributeRe = /\s(?:src|href|srcset|poster|data|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match: RegExpExecArray | null;
  while ((match = attributeRe.exec(html)) !== null) {
    const value = match[1] ?? match[2] ?? '';
    for (const candidate of value.includes(',') ? parseSrcset(value).map((e) => e.url) : [value]) {
      if (/^(?:https?:)?\/\//i.test(candidate.trim())) found.add(candidate.trim());
    }
  }
  const cssRe = /url\(\s*['"]?((?:https?:)?\/\/[^'")\s]+)/gi;
  while ((match = cssRe.exec(html)) !== null) {
    if (match[1]) found.add(match[1]);
  }
  const importRe = /@import\s+(?:url\()?['"]?((?:https?:)?\/\/[^'")\s;]+)/gi;
  while ((match = importRe.exec(html)) !== null) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}
