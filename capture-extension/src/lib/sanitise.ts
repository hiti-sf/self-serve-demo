import type { CaptureWarning } from '@demo-platform/shared';

/**
 * Script removal (SPEC §5, §11).
 *
 * Snapshots are static documents. This is both a security requirement and what makes
 * offline rendering deterministic — the player additionally sandboxes them, but this
 * layer must stand on its own.
 */

const EVENT_HANDLER_SHAPED = /^on[a-z]+$/i;

/**
 * Baseline set of inline event-handler attribute names, used when no DOM is available
 * to introspect. "on"-prefixed does not imply handler — `once` is a legitimate
 * attribute name — so matching is by name, not by prefix.
 */
const BASELINE_EVENT_HANDLERS = [
  'onabort','onanimationend','onanimationiteration','onanimationstart','onauxclick','onbeforeinput',
  'onbeforetoggle','onbeforeunload','onblur','oncancel','oncanplay','oncanplaythrough','onchange',
  'onclick','onclose','oncontextlost','oncontextmenu','oncontextrestored','oncopy','oncuechange',
  'oncut','ondblclick','ondrag','ondragend','ondragenter','ondragleave','ondragover','ondragstart',
  'ondrop','ondurationchange','onemptied','onended','onerror','onfocus','onfocusin','onfocusout',
  'onformdata','ongotpointercapture','oninput','oninvalid','onkeydown','onkeypress','onkeyup',
  'onload','onloadeddata','onloadedmetadata','onloadstart','onlostpointercapture','onmousedown',
  'onmouseenter','onmouseleave','onmousemove','onmouseout','onmouseover','onmouseup','onmousewheel',
  'onpaste','onpause','onplay','onplaying','onpointercancel','onpointerdown','onpointerenter',
  'onpointerleave','onpointermove','onpointerout','onpointerover','onpointerup','onprogress',
  'onratechange','onreset','onresize','onscroll','onscrollend','onsecuritypolicyviolation','onseeked',
  'onseeking','onselect','onselectionchange','onselectstart','onslotchange','onstalled','onsubmit',
  'onsuspend','ontimeupdate','ontoggle','ontouchcancel','ontouchend','ontouchmove','ontouchstart',
  'ontransitioncancel','ontransitionend','ontransitionrun','ontransitionstart','onunload',
  'onvolumechange','onwaiting','onwebkitanimationend','onwebkitanimationiteration',
  'onwebkitanimationstart','onwebkittransitionend','onwheel',
];

let eventHandlerNames: Set<string> | null = null;

/**
 * Prefer the real handler list from the running engine (so a new event type is covered
 * without a code change), falling back to the baseline in a DOM-less context.
 */
export function getEventHandlerNames(): ReadonlySet<string> {
  if (eventHandlerNames) return eventHandlerNames;
  const names = new Set(BASELINE_EVENT_HANDLERS);
  const proto = (globalThis as { HTMLElement?: { prototype?: object } }).HTMLElement?.prototype;
  if (proto) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (EVENT_HANDLER_SHAPED.test(key)) names.add(key.toLowerCase());
    }
  }
  eventHandlerNames = names;
  return names;
}

/**
 * True when `name` is an inline event handler on this element. Uses the element's own
 * property surface when available: `'onclick' in el` is true, `'once' in el` is not.
 */
export function isEventHandlerAttribute(name: string, element?: Element): boolean {
  const lower = name.toLowerCase();
  if (!EVENT_HANDLER_SHAPED.test(lower)) return false;
  if (element && lower in element) return true;
  return getEventHandlerNames().has(lower);
}

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

/** Assertion used by tests and by the capture pipeline before a snapshot is written. */
export function assertScriptFree(html: string): void {
  const offenders: string[] = [];
  if (/<script[\s>]/i.test(html)) offenders.push('<script> element');
  // Matched against real handler names so attributes like `once=` are not flagged.
  const handlerRe = /<[a-z][^>]*?\s(on[a-z]+)\s*=/gi;
  let handlerMatch: RegExpExecArray | null;
  while ((handlerMatch = handlerRe.exec(html)) !== null) {
    if (handlerMatch[1] && getEventHandlerNames().has(handlerMatch[1].toLowerCase())) {
      offenders.push(`inline event handler attribute (${handlerMatch[1]})`);
      break;
    }
  }
  if (/(?:href|src|action)\s*=\s*["']?\s*javascript:/i.test(html)) offenders.push('javascript: URL');
  if (offenders.length > 0) {
    throw new Error(`Snapshot is not script-free: found ${offenders.join(', ')}`);
  }
}
