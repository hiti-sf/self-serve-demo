import { computeSelector, type CaptureWarning } from '@demo-platform/shared';
import type { AnchorHint, CropRequest } from '../lib/messages.js';

/**
 * Pre-capture DOM preparation, run in the live page (SPEC §5).
 *
 * Everything here mutates the live product page, so every mutation is journalled and
 * undone in `restore()`. The author is looking at a real system; we must leave it as
 * we found it.
 *
 * Hard cases handled explicitly:
 *   <canvas>/WebGL      → rasterised to an <img>, or cropped from the page screenshot
 *   cross-origin iframe → cropped from the page screenshot (no DOM access by design)
 *   <video>             → poster frame, else the current frame, else a screenshot crop
 *   shadow DOM          → left to rrweb (open roots); closed roots are reported
 *   scrolled containers → offset preserved so the captured view matches what the author saw
 */

export interface PrepareResult {
  restore: () => void;
  warnings: CaptureWarning[];
  cropRequests: CropRequest[];
  anchorHints: AnchorHint[];
  stats: {
    rasterisedCanvases: number;
    serialisedShadowRoots: number;
    closedShadowRoots: number;
  };
}

interface Undo {
  (): void;
}

let cropCounter = 0;

function nextCropId(): string {
  cropCounter += 1;
  return `crop-${cropCounter}`;
}

export function prepareForCapture(doc: Document): PrepareResult {
  const undos: Undo[] = [];
  const warnings: CaptureWarning[] = [];
  const cropRequests: CropRequest[] = [];
  const stats = { rasterisedCanvases: 0, serialisedShadowRoots: 0, closedShadowRoots: 0 };

  const documentRect = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const view = doc.defaultView;
    return {
      x: rect.left + (view?.scrollX ?? 0),
      y: rect.top + (view?.scrollY ?? 0),
      width: rect.width,
      height: rect.height,
    };
  };

  const replaceWithPlaceholder = (
    element: Element,
    reason: CropRequest['reason'],
    label: string,
  ): void => {
    const rect = documentRect(element);
    if (rect.width < 1 || rect.height < 1) return;
    const cropId = nextCropId();
    const placeholder = doc.createElement('img');
    placeholder.setAttribute('data-demo-crop', cropId);
    placeholder.setAttribute('alt', label);
    placeholder.setAttribute(
      'style',
      `width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px;display:block;object-fit:cover;`,
    );
    const className = element.getAttribute('class');
    if (className) placeholder.setAttribute('class', className);

    const parent = element.parentNode;
    if (!parent) return;
    const next = element.nextSibling;
    parent.replaceChild(placeholder, element);
    undos.push(() => {
      if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
      parent.insertBefore(element, next);
    });
    cropRequests.push({ cropId, ...rect, reason });
  };

  const setAttributeWithUndo = (element: Element, name: string, value: string): void => {
    const had = element.hasAttribute(name);
    const previous = element.getAttribute(name);
    element.setAttribute(name, value);
    undos.push(() => {
      if (had && previous !== null) element.setAttribute(name, previous);
      else element.removeAttribute(name);
    });
  };

  // ---- 1. Freeze post-interaction form state -------------------------------------
  // The DOM property holds what the author typed; the attribute is what serialises.
  for (const input of Array.from(doc.querySelectorAll('input'))) {
    const element = input as HTMLInputElement;
    if (element.type === 'password') {
      setAttributeWithUndo(element, 'value', '');
      warnings.push({
        kind: 'pii-redacted',
        detail: 'A password field was captured empty.',
      });
      continue;
    }
    if (element.type === 'checkbox' || element.type === 'radio') {
      if (element.checked) setAttributeWithUndo(element, 'checked', '');
      else if (element.hasAttribute('checked')) {
        element.removeAttribute('checked');
        undos.push(() => element.setAttribute('checked', ''));
      }
      continue;
    }
    if (element.value) setAttributeWithUndo(element, 'value', element.value);
  }

  for (const textarea of Array.from(doc.querySelectorAll('textarea'))) {
    const element = textarea as HTMLTextAreaElement;
    const previous = element.textContent;
    element.textContent = element.value;
    undos.push(() => {
      element.textContent = previous;
    });
  }

  for (const select of Array.from(doc.querySelectorAll('select'))) {
    for (const option of Array.from((select as HTMLSelectElement).options)) {
      if (option.selected) setAttributeWithUndo(option, 'selected', '');
      else if (option.hasAttribute('selected')) {
        option.removeAttribute('selected');
        undos.push(() => option.setAttribute('selected', ''));
      }
    }
  }

  // <details open>, <dialog open> and ARIA expanded state are already attributes, so
  // an expanded menu or open modal serialises as-is. Nothing to do — this comment is
  // the note that it was checked.

  // ---- 2. Preserve inner scroll offsets ------------------------------------------
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    if (!(element instanceof HTMLElement)) continue;
    if (element.scrollTop <= 0 && element.scrollLeft <= 0) continue;
    if (element === doc.body || element === doc.documentElement) continue;
    const children = Array.from(element.children);
    if (children.length !== 1 || !(children[0] instanceof HTMLElement)) {
      warnings.push({
        kind: 'resource-fetch-failed',
        detail: `A scrolled container could not be frozen (${element.tagName.toLowerCase()} has ${children.length} children); the snapshot shows it scrolled to the top.`,
        selector: safeSelector(element),
      });
      continue;
    }
    const child = children[0] as HTMLElement;
    const previousTransform = child.style.transform;
    child.style.transform = `translate(${-element.scrollLeft}px, ${-element.scrollTop}px)`;
    undos.push(() => {
      child.style.transform = previousTransform;
    });
  }

  // ---- 3. Canvas / WebGL ---------------------------------------------------------
  for (const canvas of Array.from(doc.querySelectorAll('canvas'))) {
    const element = canvas as HTMLCanvasElement;
    const isWebgl = hasWebglContext(element);
    let dataUrl: string | null = null;
    try {
      dataUrl = element.toDataURL('image/png');
    } catch {
      dataUrl = null; // tainted by cross-origin drawImage
    }
    if (dataUrl && dataUrl.length > 512) {
      const rect = documentRect(element);
      const img = doc.createElement('img');
      img.setAttribute('src', dataUrl);
      img.setAttribute('alt', element.getAttribute('aria-label') ?? 'Chart');
      img.setAttribute('data-demo-replaced', isWebgl ? 'webgl' : 'canvas');
      img.setAttribute(
        'style',
        `width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px;display:block;`,
      );
      const parent = element.parentNode;
      if (parent) {
        const next = element.nextSibling;
        parent.replaceChild(img, element);
        undos.push(() => {
          if (img.parentNode) img.parentNode.removeChild(img);
          parent.insertBefore(element, next);
        });
        stats.rasterisedCanvases += 1;
        warnings.push({
          kind: isWebgl ? 'webgl-rasterised' : 'canvas-rasterised',
          detail: `Rasterised a <canvas> to an inline image (${Math.round(rect.width)}×${Math.round(rect.height)}).`,
          selector: safeSelector(element),
        });
      }
      continue;
    }
    // A WebGL context without preserveDrawingBuffer reads back blank. Fall through to
    // the page screenshot, which shows what the author actually saw.
    replaceWithPlaceholder(element, isWebgl ? 'webgl' : 'canvas', 'Chart');
    stats.rasterisedCanvases += 1;
    warnings.push({
      kind: isWebgl ? 'webgl-rasterised' : 'canvas-rasterised',
      detail: 'Canvas pixels were unreadable (tainted or WebGL); the region will be cropped from the page screenshot.',
      selector: safeSelector(element),
    });
  }

  // ---- 4. Cross-origin iframes ---------------------------------------------------
  for (const frame of Array.from(doc.querySelectorAll('iframe, frame'))) {
    if (isSameOriginFrame(frame as HTMLIFrameElement)) continue; // rrweb serialises these
    replaceWithPlaceholder(frame, 'cross-origin-iframe', 'Embedded content');
    warnings.push({
      kind: 'cross-origin-iframe',
      detail:
        'A cross-origin iframe cannot be serialised. Its region was cropped from the page screenshot — check the result, and exclude the element if it must not ship.',
      selector: safeSelector(frame),
    });
  }

  // ---- 5. Video ------------------------------------------------------------------
  for (const video of Array.from(doc.querySelectorAll('video'))) {
    const element = video as HTMLVideoElement;
    if (element.getAttribute('poster')) continue; // embed.ts turns the poster into an <img>
    const frame = grabVideoFrame(doc, element);
    if (frame) {
      setAttributeWithUndo(element, 'poster', frame);
      continue;
    }
    replaceWithPlaceholder(element, 'video', 'Video');
    warnings.push({
      kind: 'video-poster',
      detail: 'Video had no poster and its frame was unreadable; the region will be cropped from the page screenshot.',
      selector: safeSelector(element),
    });
  }

  // ---- 6. Shadow DOM audit -------------------------------------------------------
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow) {
      stats.serialisedShadowRoots += 1;
      continue;
    }
    if (element.tagName.includes('-') && !element.children.length && !element.textContent?.trim()) {
      // A custom element that renders nothing in the light DOM almost certainly has a
      // closed shadow root, which no serialiser can reach.
      stats.closedShadowRoots += 1;
      warnings.push({
        kind: 'shadow-root-closed',
        detail: `<${element.tagName.toLowerCase()}> appears to use a closed shadow root and will capture empty. Ask the product team for an open root, or capture the region as an image.`,
        selector: safeSelector(element),
      });
    }
  }

  return {
    restore: () => {
      // Undo in reverse so nested mutations unwind cleanly.
      for (const undo of undos.reverse()) {
        try {
          undo();
        } catch {
          /* a page script may have re-rendered the node; nothing useful to do */
        }
      }
    },
    warnings,
    cropRequests,
    anchorHints: collectAnchorHints(doc),
    stats,
  };
}

const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="link"]',
  '[data-testid]',
  '[onclick]',
].join(',');

/**
 * Pre-compute selectors for interactive elements so the editor can offer them as
 * hotspot suggestions instead of making the author hunt.
 */
export function collectAnchorHints(doc: Document, limit = 200): AnchorHint[] {
  const view = doc.defaultView;
  const documentWidth = Math.max(doc.documentElement.scrollWidth, view?.innerWidth ?? 0);
  const documentHeight = Math.max(doc.documentElement.scrollHeight, view?.innerHeight ?? 0);
  const hints: AnchorHint[] = [];

  for (const element of Array.from(doc.querySelectorAll(INTERACTIVE_SELECTOR))) {
    if (hints.length >= limit) break;
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    const style = view?.getComputedStyle(element);
    if (style && (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0')) continue;

    const { selector, strength } = computeSelector(element);
    const label =
      (element.getAttribute('aria-label') ||
        element.textContent?.trim() ||
        element.getAttribute('value') ||
        element.getAttribute('placeholder') ||
        element.tagName.toLowerCase()) ?? '';

    hints.push({
      selector,
      strength,
      label: label.replace(/\s+/g, ' ').slice(0, 120),
      x: clamp01(documentWidth > 0 ? (rect.left + (view?.scrollX ?? 0) + rect.width / 2) / documentWidth : 0),
      y: clamp01(documentHeight > 0 ? (rect.top + (view?.scrollY ?? 0) + rect.height / 2) / documentHeight : 0),
    });
  }
  return hints;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function safeSelector(element: Element): string | undefined {
  try {
    return computeSelector(element).selector;
  } catch {
    return undefined;
  }
}

function hasWebglContext(canvas: HTMLCanvasElement): boolean {
  // getContext returns the existing context if one was already created with that id.
  for (const id of ['webgl2', 'webgl', 'experimental-webgl']) {
    try {
      if (canvas.getContext(id as '2d' as never)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function isSameOriginFrame(frame: HTMLIFrameElement): boolean {
  try {
    return Boolean(frame.contentDocument?.body);
  } catch {
    return false;
  }
}

function grabVideoFrame(doc: Document, video: HTMLVideoElement): string | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  try {
    const canvas = doc.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null; // cross-origin media taints the canvas
  }
}
