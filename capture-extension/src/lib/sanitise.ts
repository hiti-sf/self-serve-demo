import {
  assertScriptFree,
  isEventHandlerAttribute,
  type CaptureWarning,
} from '@demo-platform/shared';

/**
 * Script removal (SPEC §5, §11).
 *
 * Snapshots are static documents. This is both a security requirement and what makes
 * offline rendering deterministic — the player additionally sandboxes them, but this
 * layer must stand on its own.
 */

/** Attributes that can carry an executable URL. */
const URL_ATTRIBUTES = ['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster'];

const EXECUTABLE_SCHEME = /^\s*(?:javascript|vbscript|data:text\/html)/i;

export interface SanitiseStats {
  strippedScripts: number;
  strippedEventHandlers: number;
  strippedUrls: number;
  strippedElements: number;
}

/**
 * Elements that either execute code or reach the network at render time.
 * `link` is handled separately: stylesheet links are inlined before this runs,
 * anything left is a network dependency we must not ship.
 */
const FORBIDDEN_TAGS = ['script', 'noscript', 'object', 'embed', 'applet', 'base'];

export function sanitiseDocument(doc: Document): { stats: SanitiseStats; warnings: CaptureWarning[] } {
  const stats: SanitiseStats = {
    strippedScripts: 0,
    strippedEventHandlers: 0,
    strippedUrls: 0,
    strippedElements: 0,
  };
  const warnings: CaptureWarning[] = [];

  sanitiseRoot(doc, stats);

  // <template> content is a detached fragment, so querySelectorAll on the document
  // never sees inside it. Declarative shadow DOM lives in templates, so a script
  // hidden in a shadow root would survive the main pass.
  const templates = new Set<HTMLTemplateElement>(
    Array.from(doc.querySelectorAll('template')) as HTMLTemplateElement[],
  );
  for (const template of templates) {
    sanitiseRoot(template.content, stats);
    for (const nested of Array.from(template.content.querySelectorAll('template'))) {
      templates.add(nested as HTMLTemplateElement);
    }
  }

  if (stats.strippedScripts > 0) {
    warnings.push({
      kind: 'resource-fetch-failed',
      detail: `Removed ${stats.strippedScripts} script element(s) — snapshots are static by construction.`,
    });
  }

  return { stats, warnings };
}

function sanitiseRoot(root: Document | DocumentFragment | Element, stats: SanitiseStats): void {
  for (const tag of FORBIDDEN_TAGS) {
    for (const element of Array.from(root.querySelectorAll(tag))) {
      if (tag === 'script' || tag.endsWith('script')) stats.strippedScripts += 1;
      else stats.strippedElements += 1;
      element.remove();
    }
  }

  // meta refresh navigates the snapshot away from itself.
  for (const meta of Array.from(root.querySelectorAll('meta[http-equiv]'))) {
    const equiv = meta.getAttribute('http-equiv')?.toLowerCase();
    if (equiv === 'refresh' || equiv === 'content-security-policy') {
      meta.remove();
      stats.strippedElements += 1;
    }
  }

  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (isEventHandlerAttribute(attribute.name, element)) {
        element.removeAttribute(attribute.name);
        stats.strippedEventHandlers += 1;
        continue;
      }
      if (URL_ATTRIBUTES.includes(attribute.name.toLowerCase()) && EXECUTABLE_SCHEME.test(attribute.value)) {
        element.setAttribute(attribute.name, '#');
        stats.strippedUrls += 1;
      }
      // srcdoc can smuggle a whole document, scripts included.
      if (attribute.name.toLowerCase() === 'srcdoc' && /<script/i.test(attribute.value)) {
        element.removeAttribute('srcdoc');
        stats.strippedUrls += 1;
      }
    }

    // A form in a snapshot can only navigate away; neutralise it.
    if (element.tagName === 'FORM') {
      element.removeAttribute('action');
    }
  }

  // Anchors must never navigate out of the snapshot: the player owns navigation.
  for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href') ?? '';
    if (!href.startsWith('#')) {
      anchor.setAttribute('data-demo-original-href', href.slice(0, 512));
      anchor.setAttribute('href', '#');
    }
  }
}

/**
 * Re-exported so the capture pipeline reads as one unit; the definition lives in
 * packages/shared because the editor and the demo validator enforce the same rule.
 */
export { assertScriptFree };
