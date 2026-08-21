import { computeSelector, isElement, resolveSelector, type Hotspot } from '@demo-platform/shared';

/**
 * Visual hotspot placement (SPEC §7).
 *
 * The author clicks an element in the rendered snapshot and the editor records the CSS
 * selector **and** the normalised coordinates at the same time — selector for anchoring,
 * coordinates for the fallback-image path (§4). Recording only one of them is the bug
 * this module exists to prevent.
 */

/** Marker attributes the editor adds to the snapshot document; never exported. */
export const EDITOR_STYLE_ATTRIBUTE = 'data-editor-only';
export const EDITOR_HOVER_CLASS = 'demo-editor-hover';

const HOVER_STYLE = `
.${EDITOR_HOVER_CLASS} {
  outline: 2px solid #1B91A3 !important;
  outline-offset: 1px !important;
  cursor: crosshair !important;
}
[data-editor-picked] {
  outline: 2px solid #20A676 !important;
  outline-offset: 1px !important;
}
`;

export interface PickedAnchor {
  selector: string;
  strength: 'attribute' | 'id' | 'text' | 'structural';
  /** Normalised centre within the captured document. */
  fallback: { x: number; y: number };
  /** Short label from the element, used to seed the tooltip title. */
  label: string;
  /** Rect in captured pixels, for the editor's own overlay. */
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * Describe the element the author clicked. Returns null for the document itself, where
 * an anchor would be meaningless.
 */
export function describeElement(element: Element, captured: { width: number; height: number }): PickedAnchor | null {
  if (element === element.ownerDocument.documentElement || element === element.ownerDocument.body) return null;

  const { selector, strength } = computeSelector(element);
  const box = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  const scrollX = view?.scrollX ?? 0;
  const scrollY = view?.scrollY ?? 0;

  const rect = {
    x: box.left + scrollX,
    y: box.top + scrollY,
    width: box.width,
    height: box.height,
  };

  const clamp = (value: number) => Math.min(1, Math.max(0, value));

  return {
    selector,
    strength,
    rect,
    fallback: {
      x: clamp(captured.width > 0 ? (rect.x + rect.width / 2) / captured.width : 0),
      y: clamp(captured.height > 0 ? (rect.y + rect.height / 2) / captured.height : 0),
    },
    label: elementLabel(element),
  };
}

export function elementLabel(element: Element): string {
  const raw =
    element.getAttribute('aria-label') ??
    element.getAttribute('value') ??
    element.getAttribute('placeholder') ??
    element.textContent ??
    element.tagName.toLowerCase();
  return raw.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Build a hotspot from a pick. The tooltip title is seeded from the element's own text. */
export function hotspotFromPick(hotspotId: string, pick: PickedAnchor): Hotspot {
  return {
    hotspotId,
    anchor: { selector: pick.selector, strategy: 'css' },
    anchorFallback: pick.fallback,
    trigger: 'click',
    tooltip: {
      title: pick.label ? pick.label.slice(0, 60) : '',
      body: '',
      position: 'auto',
    },
  } as Hotspot;
}

export interface PickerHandle {
  stop: () => void;
}

/**
 * Turn a snapshot document into an element picker.
 *
 * The snapshot iframe is script-free and sandboxed without `allow-scripts`, but it is
 * same-origin, so the editor can attach listeners to it from the parent. Nothing is
 * injected into the document except one style element, removed on `stop()`.
 */
export function startPicker(
  doc: Document,
  captured: { width: number; height: number },
  onPick: (pick: PickedAnchor) => void,
): PickerHandle {
  const style = doc.createElement('style');
  style.setAttribute(EDITOR_STYLE_ATTRIBUTE, 'picker');
  style.textContent = HOVER_STYLE;
  doc.head?.append(style);

  let hovered: Element | null = null;

  const onMouseOver = (event: Event) => {
    const target = event.target;
    // Duck-typed rather than `instanceof Element`: the snapshot lives in an iframe with
    // its own realm, so its nodes are not instances of *this* realm's Element. That
    // distinction is invisible in a jsdom test and fatal in a browser.
    if (!isElement(target)) return;
    if (hovered && hovered !== target) hovered.classList.remove(EDITOR_HOVER_CLASS);
    hovered = target;
    target.classList.add(EDITOR_HOVER_CLASS);
  };

  const onMouseOut = () => {
    hovered?.classList.remove(EDITOR_HOVER_CLASS);
    hovered = null;
  };

  const onClick = (event: MouseEvent) => {
    // The snapshot is a still frame; a click here is authoring, not browsing.
    event.preventDefault();
    event.stopPropagation();
    const target = event.target;
    if (!isElement(target)) return;
    const pick = describeElement(target, captured);
    if (pick) onPick(pick);
  };

  doc.addEventListener('mouseover', onMouseOver, true);
  doc.addEventListener('mouseout', onMouseOut, true);
  doc.addEventListener('click', onClick, true);

  return {
    stop() {
      doc.removeEventListener('mouseover', onMouseOver, true);
      doc.removeEventListener('mouseout', onMouseOut, true);
      doc.removeEventListener('click', onClick, true);
      hovered?.classList.remove(EDITOR_HOVER_CLASS);
      for (const node of Array.from(doc.querySelectorAll(`[${EDITOR_STYLE_ATTRIBUTE}]`))) node.remove();
      for (const node of Array.from(doc.querySelectorAll('[data-editor-picked]'))) {
        node.removeAttribute('data-editor-picked');
      }
    },
  };
}

/**
 * Whether a hotspot's selector still resolves in its snapshot. Surfaced in the editor so
 * an author sees a broken anchor while authoring rather than in front of a prospect —
 * the demo would still play, on coordinates, but silently less accurately.
 */
export function selectorResolves(doc: Document, selector: string): boolean {
  return resolveSelector(doc, selector) !== null;
}
