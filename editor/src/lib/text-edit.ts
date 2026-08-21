import { assertScriptFree, scanText, type PiiFinding } from '@demo-platform/shared';
import { EDITOR_STYLE_ATTRIBUTE } from './anchor-picker.js';

/**
 * Inline text editing of the captured DOM (SPEC §7).
 *
 * This is the payoff of DOM capture: renaming a customer, fixing a typo or adjusting a
 * number without going back to the product for a fresh capture. So it is first-class
 * here — a real editing mode over the real document, not a find-and-replace over a
 * string.
 *
 * Two rules the implementation enforces:
 *   1. Only text changes. `contenteditable` with `plaintext-only` semantics per node, and
 *      a paste handler that strips markup, so an author cannot paste a script or a
 *      `<div>` into a captured button.
 *   2. Editor artefacts never reach the exported snapshot. Everything this module adds is
 *      marked and removed by `serialiseForExport`.
 */

const EDIT_STYLE = `
[contenteditable="true"] {
  outline: 1px dashed rgba(27, 145, 163, 0.5);
  outline-offset: 1px;
}
[contenteditable="true"]:focus {
  outline: 2px solid #1B91A3;
  background: rgba(139, 195, 63, 0.14);
}
`;

/** Elements whose text an author may edit. Structural containers are left alone. */
const EDITABLE_SELECTOR = [
  'p',
  'span',
  'a',
  'li',
  'td',
  'th',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'label',
  'button',
  'dd',
  'dt',
  'strong',
  'em',
  'b',
  'i',
  'small',
  'div',
  'figcaption',
  'caption',
  'option',
].join(',');

function hasOnlyText(element: Element): boolean {
  if (element.children.length > 0) return false;
  return (element.textContent ?? '').trim().length > 0;
}

export interface TextEditHandle {
  stop: () => void;
}

/**
 * Make the leaf text nodes of a snapshot editable. Returns a handle that removes every
 * trace of edit mode from the document.
 */
export function startTextEditing(doc: Document, onChange: () => void): TextEditHandle {
  const style = doc.createElement('style');
  style.setAttribute(EDITOR_STYLE_ATTRIBUTE, 'text-edit');
  style.textContent = EDIT_STYLE;
  doc.head?.append(style);

  const touched: Element[] = [];
  for (const element of Array.from(doc.querySelectorAll(EDITABLE_SELECTOR))) {
    if (!hasOnlyText(element)) continue;
    element.setAttribute('contenteditable', 'true');
    // plaintext-only is not universal; the paste handler below is the real guard.
    element.setAttribute('data-editor-editable', '1');
    touched.push(element);
  }

  const onInput = () => onChange();

  const onPaste = (event: Event) => {
    const clipboard = (event as ClipboardEvent).clipboardData;
    if (!clipboard) return;
    event.preventDefault();
    const text = clipboard.getData('text/plain').replace(/\s+/g, ' ');
    const selection = doc.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(doc.createTextNode(text));
    selection.collapseToEnd();
    onChange();
  };

  // Enter would insert a <div> or a <br> into captured markup.
  const onKeyDown = (event: Event) => {
    if ((event as KeyboardEvent).key === 'Enter') event.preventDefault();
  };

  doc.addEventListener('input', onInput, true);
  doc.addEventListener('paste', onPaste, true);
  doc.addEventListener('keydown', onKeyDown, true);

  return {
    stop() {
      doc.removeEventListener('input', onInput, true);
      doc.removeEventListener('paste', onPaste, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      for (const element of touched) {
        element.removeAttribute('contenteditable');
        element.removeAttribute('data-editor-editable');
      }
      for (const node of Array.from(doc.querySelectorAll(`[${EDITOR_STYLE_ATTRIBUTE}]`))) node.remove();
    },
  };
}

/**
 * Serialise a snapshot document back to a storable string, with every editor artefact
 * removed. Runs the script-free check before returning: an edit pass must not be able to
 * introduce something the capture pipeline forbade.
 */
export function serialiseForExport(doc: Document): string {
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;

  for (const node of Array.from(clone.querySelectorAll(`[${EDITOR_STYLE_ATTRIBUTE}]`))) node.remove();
  for (const attribute of ['contenteditable', 'data-editor-editable', 'data-editor-picked', 'spellcheck']) {
    for (const node of Array.from(clone.querySelectorAll(`[${attribute}]`))) node.removeAttribute(attribute);
  }
  for (const node of Array.from(clone.querySelectorAll(`.demo-editor-hover`))) {
    node.classList.remove('demo-editor-hover');
    if (node.getAttribute('class') === '') node.removeAttribute('class');
  }

  const html = `<!DOCTYPE html>\n${clone.outerHTML}`;
  assertScriptFree(html);
  return html;
}

export interface TextEditPiiWarning extends PiiFinding {
  context: string;
}

/**
 * Re-scan edited text for PII (SPEC §11). The capture pass caught what was on screen at
 * capture time; an author typing a real customer name into a demo is the other way in,
 * and demo data has to stay synthetic.
 */
export function scanEditedText(doc: Document): TextEditPiiWarning[] {
  const findings: TextEditPiiWarning[] = [];
  const seen = new Set<string>();
  for (const element of Array.from(doc.querySelectorAll('[data-editor-editable], body *'))) {
    if (element.children.length > 0) continue;
    const text = element.textContent ?? '';
    if (!text.trim()) continue;
    for (const finding of scanText(text)) {
      if (seen.has(finding.match)) continue;
      seen.add(finding.match);
      findings.push({ ...finding, context: text.replace(/\s+/g, ' ').trim().slice(0, 120) });
    }
  }
  return findings;
}

/**
 * Replace a string everywhere it appears in the snapshot's visible text. Offered
 * alongside click-to-edit because "rename this customer" usually means every occurrence,
 * and hunting them one at a time across a table is how typos survive.
 */
export function replaceEverywhere(doc: Document, from: string, to: string): number {
  if (!from) return 0;
  let changed = 0;
  const walker = doc.createTreeWalker(doc.body, 0x04 /* SHOW_TEXT */);
  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue ?? '';
    if (text.includes(from)) {
      node.nodeValue = text.split(from).join(to);
      changed += 1;
    }
    node = walker.nextNode();
  }
  for (const attribute of ['value', 'placeholder', 'title', 'alt', 'aria-label']) {
    for (const element of Array.from(doc.querySelectorAll(`[${attribute}]`))) {
      const before = element.getAttribute(attribute) ?? '';
      if (!before.includes(from)) continue;
      element.setAttribute(attribute, before.split(from).join(to));
      changed += 1;
    }
  }
  return changed;
}
