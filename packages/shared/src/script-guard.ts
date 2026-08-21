/**
 * The script-free guarantee (SPEC §5, §11).
 *
 * Snapshots are static documents: no scripts, no inline event handlers, no executable
 * URLs. Three places need to agree on what that means — the capture extension that
 * produces snapshots, the editor that imports and edits them, and the validator that
 * gates the repo — so the definition lives here rather than in any one of them.
 */

const EVENT_HANDLER_SHAPED = /^on[a-z]+$/i;

/**
 * Baseline set of inline event-handler attribute names, used when no DOM is available to
 * introspect. "on"-prefixed does not imply handler — `once` is a legitimate attribute
 * name — so matching is by name, not by prefix.
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

let cachedNames: Set<string> | null = null;

/**
 * Prefer the real handler list from the running engine, so a newly standardised event is
 * covered without a code change; fall back to the baseline in a DOM-less context.
 */
export function getEventHandlerNames(): ReadonlySet<string> {
  if (cachedNames) return cachedNames;
  const names = new Set(BASELINE_EVENT_HANDLERS);
  const proto = (globalThis as { HTMLElement?: { prototype?: object } }).HTMLElement?.prototype;
  if (proto) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (EVENT_HANDLER_SHAPED.test(key)) names.add(key.toLowerCase());
    }
  }
  cachedNames = names;
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

export class ScriptFreeViolation extends Error {
  readonly offenders: string[];

  constructor(offenders: string[]) {
    super(`Snapshot is not script-free: found ${offenders.join(', ')}`);
    this.name = 'ScriptFreeViolation';
    this.offenders = offenders;
  }
}

/** Throws a ScriptFreeViolation naming what was found. */
export function assertScriptFree(html: string): void {
  const offenders = findScriptViolations(html);
  if (offenders.length > 0) throw new ScriptFreeViolation(offenders);
}

export function isScriptFree(html: string): boolean {
  return findScriptViolations(html).length === 0;
}

export function findScriptViolations(html: string): string[] {
  const offenders: string[] = [];

  if (/<script[\s>]/i.test(html)) offenders.push('<script> element');

  // Anchored to attribute position, and matched against real handler names, so body
  // text like "once=1" is not a false positive.
  const handlerRe = /<[a-z][^>]*?\s(on[a-z]+)\s*=/gi;
  let match: RegExpExecArray | null;
  while ((match = handlerRe.exec(html)) !== null) {
    if (match[1] && getEventHandlerNames().has(match[1].toLowerCase())) {
      offenders.push(`inline event handler attribute (${match[1]})`);
      break;
    }
  }

  if (/(?:href|src|action|formaction)\s*=\s*["']?\s*(?:javascript|vbscript):/i.test(html)) {
    offenders.push('javascript: URL');
  }

  return offenders;
}
