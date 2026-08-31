import type { CaptureWarning } from '@demo-platform/shared';
import {
  extractCssUrls,
  isExternalUrl,
  parseSrcset,
  resolveUrl,
  rewriteCssUrls,
  serialiseSrcset,
  stripCssImports,
} from './urls.js';

/**
 * Resource embedding (SPEC §5): every remaining network reference becomes a data URI
 * so the snapshot renders identically offline.
 *
 * Fetching is injected rather than called directly: in the extension it is proxied
 * through the service worker (which holds host permissions and so is not blocked by
 * the page's CORS policy), and in tests it is a stub.
 */

export interface FetchedResource {
  dataUrl: string;
  bytes: number;
  contentType: string;
}

export type ResourceFetcher = (url: string) => Promise<FetchedResource | null>;

export interface EmbedOptions {
  baseUrl: string;
  fetchResource: ResourceFetcher;
  /** Skip anything larger than this; a 40 MB hero video is not worth a demo step. */
  maxResourceBytes?: number;
  /** Total embedded budget. Snapshots above this get slow to render in an iframe. */
  maxTotalBytes?: number;
}

export interface EmbedResult {
  embedded: number;
  skipped: number;
  totalBytes: number;
  warnings: CaptureWarning[];
}

export const DEFAULT_MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 48 * 1024 * 1024;

/** Transparent 1x1 GIF — stands in for a resource we could not embed. */
export const BLANK_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export async function embedResources(doc: Document, options: EmbedOptions): Promise<EmbedResult> {
  const maxResourceBytes = options.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const result: EmbedResult = { embedded: 0, skipped: 0, totalBytes: 0, warnings: [] };
  const cache = new Map<string, string | null>();

  /**
   * `url` must already be absolute. Resolution is the caller's job because the correct
   * base differs per context: the document for attributes, the stylesheet's own href
   * for url() references inside it.
   */
  const load = async (url: string): Promise<string | null> => {
    const absolute = url;
    if (cache.has(absolute)) return cache.get(absolute) ?? null;

    if (result.totalBytes >= maxTotalBytes) {
      cache.set(absolute, null);
      result.skipped += 1;
      result.warnings.push({
        kind: 'resource-too-large',
        detail: `Snapshot resource budget (${Math.round(maxTotalBytes / 1024 / 1024)} MB) exhausted before ${absolute}`,
      });
      return null;
    }

    let fetched: FetchedResource | null = null;
    try {
      fetched = await options.fetchResource(absolute);
    } catch (error) {
      fetched = null;
      result.warnings.push({
        kind: 'resource-fetch-failed',
        detail: `${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    if (!fetched) {
      cache.set(absolute, null);
      result.skipped += 1;
      if (!result.warnings.some((w) => w.detail.startsWith(absolute))) {
        result.warnings.push({
          kind: 'resource-fetch-failed',
          detail: `${absolute}: not embedded — the snapshot will render without it`,
        });
      }
      return null;
    }

    if (fetched.bytes > maxResourceBytes) {
      cache.set(absolute, null);
      result.skipped += 1;
      result.warnings.push({
        kind: 'resource-too-large',
        detail: `${absolute} is ${Math.round(fetched.bytes / 1024)} kB, above the per-resource limit`,
      });
      return null;
    }

    cache.set(absolute, fetched.dataUrl);
    result.embedded += 1;
    result.totalBytes += fetched.bytes;
    return fetched.dataUrl;
  };

  // 1. Stylesheet links that survived capture (cross-origin sheets the page could not read).
  for (const link of queryAllDeep(doc, 'link[rel~="stylesheet"][href]')) {
    const href = link.getAttribute('href') ?? '';
    if (!isExternalUrl(href)) continue;
    const absolute = resolveUrl(href, options.baseUrl);
    const fetched = await options.fetchResource(absolute).catch(() => null);
    if (!fetched) {
      link.remove();
      result.skipped += 1;
      result.warnings.push({
        kind: 'cross-origin-stylesheet',
        detail: `Could not inline stylesheet ${absolute}; it was dropped so the snapshot stays offline-safe.`,
      });
      continue;
    }
    const cssText = dataUrlToText(fetched.dataUrl);
    const style = doc.createElement('style');
    style.setAttribute('data-demo-inlined-from', absolute.slice(0, 512));
    style.textContent = await inlineCssUrls(cssText, absolute, load);
    link.replaceWith(style);
    result.embedded += 1;
    result.totalBytes += fetched.bytes;
  }

  // 2. Anything else a <link> would pull at render time (icons, prefetch, fonts).
  for (const link of queryAllDeep(doc, 'link[href]')) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase();
    const href = link.getAttribute('href') ?? '';
    if (!isExternalUrl(href)) continue;
    if (rel.includes('icon')) {
      const dataUrl = await load(resolveUrl(href, options.baseUrl));
      if (dataUrl) link.setAttribute('href', dataUrl);
      else link.remove();
    } else {
      link.remove();
    }
  }

  // 3. <style> blocks: fonts and background images live in url() references.
  for (const style of queryAllDeep(doc, 'style')) {
    const cssText = style.textContent ?? '';
    if (!cssText) continue;
    const from = style.getAttribute('data-demo-inlined-from') ?? options.baseUrl;
    style.textContent = await inlineCssUrls(cssText, from, load);
  }

  // 4. Images, including srcset and <picture> sources.
  for (const img of queryAllDeep(doc, 'img, input[type="image"]')) {
    const src = img.getAttribute('src') ?? '';
    if (isExternalUrl(src)) {
      const dataUrl = await load(resolveUrl(src, options.baseUrl));
      img.setAttribute('src', dataUrl ?? BLANK_IMAGE);
      if (!dataUrl) img.setAttribute('data-demo-missing-src', '1');
    }
    img.removeAttribute('loading');
    await rewriteSrcset(img, options.baseUrl, load);
  }
  for (const source of queryAllDeep(doc, 'source')) {
    const src = source.getAttribute('src') ?? '';
    if (isExternalUrl(src)) {
      const dataUrl = await load(resolveUrl(src, options.baseUrl));
      if (dataUrl) source.setAttribute('src', dataUrl);
      else source.remove();
      continue;
    }
    await rewriteSrcset(source, options.baseUrl, load);
  }

  // 5. Inline style attributes (url() in a style="" attribute).
  for (const element of queryAllDeep(doc, '[style*="url("]')) {
    const styleAttr = element.getAttribute('style') ?? '';
    element.setAttribute('style', await inlineCssUrls(styleAttr, options.baseUrl, load));
  }

  // 6. SVG <image> and <use> external references.
  for (const node of queryAllDeep(doc, 'image, use')) {
    for (const attribute of ['href', 'xlink:href']) {
      const value = node.getAttribute(attribute);
      if (!value || !isExternalUrl(value)) continue;
      const dataUrl = await load(resolveUrl(value, options.baseUrl));
      if (dataUrl) node.setAttribute(attribute, dataUrl);
      else node.removeAttribute(attribute);
    }
  }

  // 7. Video/audio: the poster frame is the demo asset, the media itself is not (§5, v1).
  for (const media of queryAllDeep(doc, 'video, audio')) {
    const poster = media.getAttribute('poster') ?? '';
    if (media.tagName === 'VIDEO') {
      const dataUrl = isExternalUrl(poster) ? await load(resolveUrl(poster, options.baseUrl)) : poster || null;
      const img = doc.createElement('img');
      img.setAttribute('src', dataUrl ?? BLANK_IMAGE);
      img.setAttribute('alt', media.getAttribute('aria-label') ?? 'Video');
      img.setAttribute('data-demo-replaced', 'video');
      copyLayoutAttributes(media, img);
      applyMeasuredBox(media, img);
      media.replaceWith(img);
      result.warnings.push({
        kind: 'video-poster',
        detail: 'A <video> element was replaced by its poster frame. Video steps are out of scope for v1.',
      });
    } else {
      media.remove();
    }
  }

  return result;
}

async function rewriteSrcset(
  element: Element,
  baseUrl: string,
  load: (url: string) => Promise<string | null>,
): Promise<void> {
  const srcset = element.getAttribute('srcset');
  if (!srcset) return;
  const entries = parseSrcset(srcset);
  const rewritten: { url: string; descriptor: string }[] = [];
  for (const entry of entries) {
    if (!isExternalUrl(entry.url)) {
      rewritten.push(entry);
      continue;
    }
    const dataUrl = await load(resolveUrl(entry.url, baseUrl));
    if (dataUrl) rewritten.push({ url: dataUrl, descriptor: entry.descriptor });
  }
  if (rewritten.length === 0) element.removeAttribute('srcset');
  else element.setAttribute('srcset', serialiseSrcset(rewritten));
}

async function inlineCssUrls(
  cssText: string,
  baseUrl: string,
  load: (url: string) => Promise<string | null>,
): Promise<string> {
  const withoutImports = stripCssImports(cssText);
  const refs = extractCssUrls(withoutImports, baseUrl);
  const replacements = new Map<string, string>();
  for (const ref of refs) {
    // ref.absolute is resolved against the stylesheet's href, not the document's:
    // a font referenced from a CDN stylesheet lives next to that stylesheet.
    const dataUrl = await load(ref.absolute);
    if (dataUrl) replacements.set(ref.raw, dataUrl);
  }
  return rewriteCssUrls(withoutImports, replacements);
}

/**
 * `querySelectorAll` stops at a `<template>` boundary, because its content is a detached
 * fragment. Shadow roots arrive here as declarative templates, so every embedding pass
 * has to descend into them or a component's images and fonts would be left pointing at
 * the network — which the kiosk build forbids (§8.2).
 */
function queryAllDeep(root: Document | DocumentFragment, selector: string): Element[] {
  const found = Array.from(root.querySelectorAll(selector));
  for (const template of Array.from(root.querySelectorAll('template'))) {
    found.push(...queryAllDeep((template as HTMLTemplateElement).content, selector));
  }
  return found;
}

/**
 * A <video> is laid out by CSS that selects on the tag name, so the <img> that replaces
 * its poster inherits none of it and renders at the poster's natural size. The content
 * script measured the element while it still had layout; re-apply that box here.
 */
function applyMeasuredBox(from: Element, to: Element): void {
  const box = from.getAttribute('data-demo-box');
  const [width = NaN, height = NaN] = (box ?? '').split('x').map(Number);
  if (!(width >= 1) || !(height >= 1)) return;
  const existing = to.getAttribute('style') ?? '';
  to.setAttribute('style', `${existing}${existing && !existing.endsWith(';') ? ';' : ''}width:${width}px;height:${height}px;object-fit:contain;`);
  to.removeAttribute('data-demo-box');
}

function copyLayoutAttributes(from: Element, to: Element): void {
  for (const attribute of ['width', 'height', 'class', 'style']) {
    const value = from.getAttribute(attribute);
    if (value) to.setAttribute(attribute, value);
  }
}

/** Decode a data: URL back to text — used for stylesheets fetched by the worker. */
export function dataUrlToText(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return '';
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (!header.includes(';base64')) return decodeURIComponent(body);
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
