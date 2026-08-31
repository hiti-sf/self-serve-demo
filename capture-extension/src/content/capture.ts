import { snapshot } from 'rrweb-snapshot';
import { nowIso, randomId } from '@demo-platform/shared';
import { fail, ok, type Message, type PageMetrics, type RawCapture, type Response } from '../lib/messages.js';
import { prepareForCapture } from './prepare.js';

/**
 * Content script: the only context with access to the live product DOM.
 *
 * DOM traversal is delegated to rrweb-snapshot (MIT) rather than hand-rolled — see
 * EVALUATION.md. rrweb gives us stylesheet inlining, input state, shadow roots and
 * same-origin iframe descent; this file owns everything rrweb does not do:
 * pre-capture state freezing, the hard cases (canvas/WebGL/cross-origin frames/video)
 * and anchor hints for the editor.
 */

function readMetrics(): PageMetrics {
  const doc = document;
  const view = window;
  return {
    url: location.href,
    title: doc.title ?? '',
    viewport: {
      width: view.innerWidth,
      height: view.innerHeight,
      devicePixelRatio: view.devicePixelRatio || 1,
      documentWidth: Math.max(doc.documentElement.scrollWidth, view.innerWidth),
      documentHeight: Math.max(doc.documentElement.scrollHeight, view.innerHeight),
      scrollX: Math.round(view.scrollX),
      scrollY: Math.round(view.scrollY),
    },
  };
}

function captureDom(captureId: string): RawCapture {
  const metrics = readMetrics();
  const prepared = prepareForCapture(document);

  try {
    const tree = snapshot(document, {
      // rrweb pulls same-origin stylesheet rules into the tree; cross-origin sheets
      // are picked up later by embed.ts through the worker's privileged fetch.
      inlineStylesheet: true,
      // Best effort in the page context; anything CORS-blocked is retried by the worker.
      inlineImages: true,
      recordCanvas: true,
      // Never mask: demo data is synthetic, and the author reviews PII explicitly (§5).
      maskAllInputs: false,
      // Drop scripts and preload hints at serialisation time — the first of three
      // layers that keep snapshots static (§11).
      slimDOM: {
        script: true,
        comment: true,
        headFavicon: false,
        headWhitespace: true,
        headMetaSocial: true,
        headMetaRobots: true,
        headMetaHttpEquiv: true,
        headMetaVerification: true,
        headMetaAuthorship: false,
        headMetaDescKeywords: false,
      },
      dataURLOptions: { type: 'image/webp', quality: 0.9 },
      preserveWhiteSpace: true,
      iframeLoadTimeout: 3000,
      stylesheetLoadTimeout: 3000,
    });

    if (!tree) throw new Error('rrweb-snapshot returned no tree for this document');

    return {
      captureId,
      url: metrics.url,
      title: metrics.title,
      timestamp: nowIso(),
      viewport: metrics.viewport,
      tree,
      anchorHints: prepared.anchorHints,
      warnings: prepared.warnings,
      cropRequests: prepared.cropRequests,
      stats: {
        // Script counts are finalised by the sanitiser in the offscreen document,
        // which sees the rebuilt DOM; rrweb has already dropped most of them.
        strippedScripts: 0,
        strippedEventHandlers: 0,
        rasterisedCanvases: prepared.stats.rasterisedCanvases,
        serialisedShadowRoots: prepared.stats.serialisedShadowRoots,
      },
    };
  } finally {
    prepared.restore();
  }
}

chrome.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse: (response: Response<unknown>) => void) => {
    try {
      switch (message.type) {
        case 'content/metrics':
          sendResponse(ok(readMetrics()));
          return false;

        case 'content/scroll-to':
          window.scrollTo({ top: message.y, behavior: 'instant' as ScrollBehavior });
          // Give the page a frame to settle (lazy images, sticky headers) before the
          // worker grabs the slice.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => sendResponse(ok({ y: window.scrollY })));
          });
          return true;

        case 'content/restore-scroll':
          window.scrollTo({ top: message.y, behavior: 'instant' as ScrollBehavior });
          sendResponse(ok({ y: window.scrollY }));
          return false;

        case 'content/capture':
          sendResponse(ok(captureDom(message.captureId ?? `cap_${randomId(12)}`)));
          return false;

        default:
          return false;
      }
    } catch (error) {
      sendResponse(fail(error));
      return false;
    }
  },
);
