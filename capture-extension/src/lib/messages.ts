import type { CaptureMeta, CaptureWarning, PiiFinding } from '@demo-platform/shared';

/**
 * Typed message protocol between popup ⇄ service worker ⇄ content script ⇄ offscreen doc.
 *
 * The capture pipeline is split across four contexts because each one owns a
 * capability the others lack:
 *   content script  — access to the live DOM
 *   service worker  — host-permission fetch (bypasses page CORS) + downloads + tab capture
 *   offscreen doc   — a DOM to rebuild into, and OffscreenCanvas for image stitching
 *   popup           — the author's review/redact UI
 */

export interface AnchorHint {
  selector: string;
  strength: 'attribute' | 'id' | 'text' | 'structural';
  label: string;
  x: number;
  y: number;
}

export interface ViewportInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
  documentWidth: number;
  documentHeight: number;
  scrollX: number;
  scrollY: number;
}

/** What the content script hands back: an rrweb serialised tree plus context. */
/** A region of the page screenshot that must be pasted into the snapshot. */
export interface CropRequest {
  cropId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  reason: 'canvas' | 'webgl' | 'cross-origin-iframe' | 'video';
}

export interface RawCapture {
  captureId: string;
  url: string;
  title: string;
  timestamp: string;
  viewport: ViewportInfo;
  /** rrweb-snapshot serialisedNodeWithId tree, structurally opaque to us. */
  tree: unknown;
  anchorHints: AnchorHint[];
  warnings: CaptureWarning[];
  cropRequests: CropRequest[];
  stats: {
    strippedScripts: number;
    strippedEventHandlers: number;
    rasterisedCanvases: number;
    serialisedShadowRoots: number;
  };
}

/** What the offscreen converter produces before the author reviews it. */
export interface ConvertedCapture {
  captureId: string;
  html: string;
  /** PII candidates found in the serialised document's text nodes. */
  piiFindings: (PiiFinding & { context: string })[];
  warnings: CaptureWarning[];
  embeddedResources: number;
}

export interface CaptureResult {
  meta: CaptureMeta;
  html: string;
  /** data: URL of the full-page fallback PNG. */
  fallbackPng: string;
  piiFindings: (PiiFinding & { context: string })[];
}

export type Message =
  /* popup → service worker */
  | { type: 'capture/start'; tabId?: number }
  | { type: 'capture/save'; captureId: string; redactions: string[]; folder: string }
  | { type: 'capture/get-last' }
  /* service worker → content script */
  | { type: 'content/capture'; captureId: string }
  /* offscreen conversion */
  | {
      type: 'offscreen/convert';
      raw: RawCapture;
      /** Full-page screenshot, used for crop regions the DOM cannot express. */
      fallbackPng: string;
    }
  | { type: 'offscreen/stitch'; slices: { dataUrl: string; y: number }[]; width: number; height: number; devicePixelRatio: number }
  /* content script scroll driving for the full-page fallback */
  | { type: 'content/metrics' }
  | { type: 'content/scroll-to'; y: number }
  | { type: 'content/restore-scroll'; y: number };

/** Page geometry, read before the screenshot pass so slices line up. */
export interface PageMetrics {
  viewport: ViewportInfo;
  url: string;
  title: string;
}

export type Response<T> = { ok: true; data: T } | { ok: false; error: string };

export function ok<T>(data: T): Response<T> {
  return { ok: true, data };
}

export function fail(error: unknown): Response<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function sendToBackground<T>(message: Message): Promise<Response<T>> {
  return chrome.runtime.sendMessage(message) as Promise<Response<T>>;
}
