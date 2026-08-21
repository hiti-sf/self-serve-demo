import { redactMatches, scanText, type PiiFinding } from '@demo-platform/shared';
import { assertScriptFree } from './sanitise.js';

/**
 * Final document → HTML string, plus the PII review pass the author signs off (SPEC §5).
 */

/**
 * Third defence layer, after "no scripts in the document" and "sandboxed iframe in the
 * player": a snapshot-level CSP that permits only inline styles and data: assets. If a
 * network reference ever survives embedding, this stops it reaching the network.
 */
export const SNAPSHOT_CSP =
  "default-src 'none'; img-src data: blob:; media-src data:; style-src 'unsafe-inline' data:; font-src data:; frame-src 'none'; script-src 'none'; form-action 'none'";

export interface SnapshotMetaAttributes {
  captureId: string;
  sourceUrl: string;
  capturedAt: string;
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
}

/**
 * Stamp the snapshot with capture provenance and a hard CSP, then serialise.
 * Must run AFTER sanitisation (which strips existing CSP/meta-refresh tags) so the
 * CSP we add is the only one in the document.
 */
export function serialiseDocument(doc: Document, meta: SnapshotMetaAttributes): string {
  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement('head'), doc.body);

  if (!head.querySelector('meta[charset]')) {
    const charset = doc.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    head.prepend(charset);
  }

  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', SNAPSHOT_CSP);
  head.prepend(csp);

  const root = doc.documentElement;
  root.setAttribute('data-demo-capture-id', meta.captureId);
  root.setAttribute('data-demo-source-url', meta.sourceUrl.slice(0, 1024));
  root.setAttribute('data-demo-captured-at', meta.capturedAt);
  root.setAttribute('data-demo-viewport', `${meta.viewportWidth}x${meta.viewportHeight}`);
  root.setAttribute('data-demo-document', `${meta.documentWidth}x${meta.documentHeight}`);

  // The player letterboxes the snapshot at its captured size; scrollbars inside the
  // iframe would double up with the player's own chrome.
  const style = doc.createElement('style');
  style.setAttribute('data-demo-player-reset', '');
  style.textContent = `html{overflow:hidden !important;}body{margin:0;}*{animation:none !important;transition:none !important;caret-color:transparent !important;}`;
  head.append(style);

  const html = `<!DOCTYPE html>\n${root.outerHTML}`;
  assertScriptFree(html);
  return html;
}

export interface DocumentPiiFinding extends PiiFinding {
  /** Surrounding text so the author can judge whether it is real. */
  context: string;
}

const SKIP_TEXT_PARENTS = new Set(['STYLE', 'SCRIPT', 'TITLE', 'TEMPLATE']);

function* textNodes(root: Document | DocumentFragment): Generator<Text> {
  const doc = 'ownerDocument' in root && root.ownerDocument ? root.ownerDocument : (root as Document);
  const walker = doc.createTreeWalker(root, 0x04 /* NodeFilter.SHOW_TEXT */);
  let node = walker.nextNode();
  while (node) {
    yield node as Text;
    node = walker.nextNode();
  }
}

/**
 * Scan the serialised document for PII candidates. Deliberately runs over the final
 * document rather than the live page, so redactions cannot be undone by a later pass.
 */
export function scanDocumentForPii(doc: Document): DocumentPiiFinding[] {
  const findings: DocumentPiiFinding[] = [];
  const seen = new Set<string>();

  const collect = (text: string) => {
    for (const finding of scanText(text)) {
      if (seen.has(finding.match)) continue;
      seen.add(finding.match);
      const from = Math.max(0, finding.start - 40);
      const to = Math.min(text.length, finding.end + 40);
      findings.push({ ...finding, context: text.slice(from, to).replace(/\s+/g, ' ').trim() });
    }
  };

  for (const node of textNodes(doc)) {
    if (node.parentElement && SKIP_TEXT_PARENTS.has(node.parentElement.tagName)) continue;
    const text = node.nodeValue ?? '';
    if (text.trim().length > 0) collect(text);
  }

  // Values the author typed into the product before capturing.
  for (const element of Array.from(doc.querySelectorAll('input[value], textarea, [placeholder], [title], img[alt]'))) {
    for (const attribute of ['value', 'placeholder', 'title', 'alt']) {
      const value = element.getAttribute(attribute);
      if (value && value.trim()) collect(value);
    }
    if (element.tagName === 'TEXTAREA' && element.textContent) collect(element.textContent);
  }

  for (const template of Array.from(doc.querySelectorAll('template'))) {
    for (const node of textNodes((template as HTMLTemplateElement).content)) {
      const text = node.nodeValue ?? '';
      if (text.trim().length > 0) collect(text);
    }
  }

  return findings;
}

/**
 * Apply the author's chosen redactions across text nodes and user-visible attributes.
 * Returns how many nodes changed, for the capture warning trail.
 */
export function applyRedactions(doc: Document, matches: readonly string[]): number {
  if (matches.length === 0) return 0;
  let changed = 0;

  const redactNode = (node: Text) => {
    const before = node.nodeValue ?? '';
    if (!before) return;
    const after = redactMatches(before, matches);
    if (after !== before) {
      node.nodeValue = after;
      changed += 1;
    }
  };

  for (const node of textNodes(doc)) {
    if (node.parentElement && SKIP_TEXT_PARENTS.has(node.parentElement.tagName)) continue;
    redactNode(node);
  }
  for (const template of Array.from(doc.querySelectorAll('template'))) {
    for (const node of textNodes((template as HTMLTemplateElement).content)) redactNode(node);
  }

  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attribute of ['value', 'placeholder', 'title', 'alt', 'aria-label']) {
      const before = element.getAttribute(attribute);
      if (!before) continue;
      const after = redactMatches(before, matches);
      if (after !== before) {
        element.setAttribute(attribute, after);
        changed += 1;
      }
    }
  }

  return changed;
}

export function parseHtmlToDocument(html: string, parser: DOMParser): Document {
  return parser.parseFromString(html, 'text/html');
}
