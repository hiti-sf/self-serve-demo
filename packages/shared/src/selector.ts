/**
 * Robust CSS selector computation and resolution.
 *
 * Selector-first anchoring is the whole point of DOM capture (SPEC §4): hotspots must
 * survive window resizing and minor layout shifts. This module is shared by the capture
 * extension (which records candidate selectors) and the editor (which records the
 * selector when the author clicks an element), so both produce identical output.
 */

/** Attributes that authors and product engineers can be trusted to keep stable. */
export const STABLE_ATTRIBUTES: readonly string[] = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-qa',
  'data-cy',
  'data-demo-id',
  'data-anchor',
  'name',
];

/**
 * ids produced by frameworks change on every build, so they are worse than a
 * structural path. Reject anything that looks generated.
 */
export function isLikelyGeneratedId(id: string): boolean {
  if (id.length === 0 || id.length > 64) return true;
  if (/^[0-9]/.test(id)) return true; // needs escaping and is rarely authored
  if (/^(?:radix|mui|chakra|headlessui|react-aria|ember|ext-gen|yui|:r)/i.test(id)) return true;
  if (/[0-9a-f]{8,}/i.test(id)) return true; // embedded hash
  if (/(?:^|[-_])\d{4,}(?:$|[-_])/.test(id)) return true; // embedded counter
  if (/^[a-z]{1,3}\d{3,}$/i.test(id)) return true; // e.g. el12345
  return false;
}

export function cssEscape(value: string): string {
  // Plain identifiers need no escaping, and skipping it keeps selectors readable
  // for the author reviewing them in the editor.
  if (/^-?[A-Za-z_][\w-]*$/.test(value)) return value;
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (css && typeof css.escape === 'function') return css.escape(value);
  return value.replace(/([^\w-])/g, '\\$1');
}

function isElement(node: unknown): node is Element {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { nodeType?: number }).nodeType === 1 &&
    typeof (node as { tagName?: unknown }).tagName === 'string'
  );
}

function tagName(element: Element): string {
  return element.tagName.toLowerCase();
}

/** Class names that are visual/state noise rather than identity. */
function meaningfulClasses(element: Element): string[] {
  return Array.from(element.classList)
    .filter((cls) => cls.length > 1 && cls.length <= 40)
    .filter((cls) => !/\d{3,}|[0-9a-f]{6,}/i.test(cls)) // hashed utility class
    .filter((cls) => !/^(?:is-|has-|active|open|selected|hover|focus|disabled)/.test(cls))
    .slice(0, 2);
}

function matchesUniquely(root: Document | ShadowRoot, selector: string, element: Element): boolean {
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === element;
  } catch {
    return false;
  }
}

function nthOfTypeIndex(element: Element): number {
  const parent = element.parentElement;
  if (!parent) return 1;
  let index = 1;
  for (const sibling of Array.from(parent.children)) {
    if (sibling === element) return index;
    if (sibling.tagName === element.tagName) index += 1;
  }
  return index;
}

export interface SelectorResult {
  selector: string;
  /**
   * How resilient the selector is expected to be:
   *  - 'attribute': a stable data-* / name attribute
   *  - 'id': an authored-looking id
   *  - 'text': tag + unique text content
   *  - 'structural': a positional path — will break if the DOM is restructured
   */
  strength: 'attribute' | 'id' | 'text' | 'structural';
  unique: boolean;
}

/**
 * Compute the most resilient unique selector for `element`, preferring stable
 * attributes and ids, then a tag+class path, and finally a positional path.
 */
export function computeSelector(element: Element): SelectorResult {
  const root = element.getRootNode() as Document | ShadowRoot;

  for (const attribute of STABLE_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value && value.length <= 120) {
      const selector = `[${attribute}="${value.replace(/"/g, '\\"')}"]`;
      if (matchesUniquely(root, selector, element)) {
        return { selector, strength: 'attribute', unique: true };
      }
      const scoped = `${tagName(element)}${selector}`;
      if (matchesUniquely(root, scoped, element)) {
        return { selector: scoped, strength: 'attribute', unique: true };
      }
    }
  }

  const id = element.getAttribute('id');
  if (id && !isLikelyGeneratedId(id)) {
    const selector = `#${cssEscape(id)}`;
    if (matchesUniquely(root, selector, element)) {
      return { selector, strength: 'id', unique: true };
    }
  }

  // aria-label is authored copy, and copy is stable enough for a demo snapshot.
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.length <= 80) {
    const selector = `${tagName(element)}[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
    if (matchesUniquely(root, selector, element)) {
      return { selector, strength: 'attribute', unique: true };
    }
  }

  const path = structuralPath(element, root);
  return { selector: path.selector, strength: 'structural', unique: path.unique };
}

function structuralPath(
  element: Element,
  root: Document | ShadowRoot,
): { selector: string; unique: boolean } {
  const parts: string[] = [];
  let current: Element | null = element;
  let depth = 0;

  while (current && depth < 12) {
    let part = tagName(current);

    const currentId = current.getAttribute('id');
    if (currentId && !isLikelyGeneratedId(currentId)) {
      parts.unshift(`#${cssEscape(currentId)}`);
      break;
    }

    const classes = meaningfulClasses(current);
    if (classes.length > 0) {
      part += classes.map((cls) => `.${cssEscape(cls)}`).join('');
    }

    const parent: Element | null = current.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
      if (sameTag.length > 1) {
        part += `:nth-of-type(${nthOfTypeIndex(current)})`;
      }
    }

    parts.unshift(part);

    const candidate = parts.join(' > ');
    if (matchesUniquely(root, candidate, element)) {
      return { selector: candidate, unique: true };
    }

    current = parent;
    depth += 1;
  }

  const selector = parts.join(' > ');
  return { selector, unique: matchesUniquely(root, selector, element) };
}

/**
 * Resolve a selector inside a snapshot document. Returns null when the selector no
 * longer matches — the caller then falls back to normalised coordinates (§4).
 */
export function resolveSelector(doc: Document, selector: string): Element | null {
  try {
    const direct = doc.querySelector(selector);
    if (direct) return direct;
  } catch {
    return null;
  }
  // Snapshots serialise shadow roots as declarative shadow DOM; in a script-free
  // document those templates are attached by the parser, so search open roots too.
  return resolveInShadowRoots(doc, selector);
}

function resolveInShadowRoots(root: Document | ShadowRoot, selector: string): Element | null {
  const hosts = root.querySelectorAll('*');
  for (const host of Array.from(hosts)) {
    const shadow = (host as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (!shadow) continue;
    try {
      const found = shadow.querySelector(selector);
      if (found) return found;
    } catch {
      return null;
    }
    const nested = resolveInShadowRoots(shadow, selector);
    if (nested) return nested;
  }
  return null;
}

/** Normalised (0..1) centre of an element within the captured document. */
export function normalisedCentre(
  element: Element,
  docWidth: number,
  docHeight: number,
): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  const scrollX = element.ownerDocument.defaultView?.scrollX ?? 0;
  const scrollY = element.ownerDocument.defaultView?.scrollY ?? 0;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return {
    x: clamp(docWidth > 0 ? (rect.left + scrollX + rect.width / 2) / docWidth : 0),
    y: clamp(docHeight > 0 ? (rect.top + scrollY + rect.height / 2) / docHeight : 0),
  };
}

export { isElement };
