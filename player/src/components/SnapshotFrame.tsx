import { useEffect, useRef, useState } from 'react';
import type { Fit } from '../geometry.js';

/**
 * Renders one captured snapshot (SPEC §6).
 *
 * The snapshot goes into a `sandbox="allow-same-origin"` iframe via `srcdoc`: no
 * `allow-scripts`, so nothing in the captured document can execute, while same-origin
 * access lets the overlay resolve hotspot selectors inside it. Snapshots are already
 * script-free by construction — this is the second layer, deliberately (§11).
 *
 * The iframe is laid out at the captured size and scaled with a transform, so the
 * snapshot letterboxes instead of reflowing.
 */

export interface SnapshotFrameProps {
  /** Snapshot HTML, or null to go straight to the fallback image. */
  html: string | null;
  fallbackImageUrl: string;
  fit: Fit;
  title: string;
  /** Called with the snapshot document once it is ready for selector resolution. */
  onDocumentReady: (doc: Document | null) => void;
  /** Called when the snapshot could not render and the image took over. */
  onFallback?: (reason: string) => void;
  /** How long to wait for the iframe to report a usable document. */
  readyTimeoutMs?: number;
}

export function SnapshotFrame({
  html,
  fallbackImageUrl,
  fit,
  title,
  onDocumentReady,
  onFallback,
  readyTimeoutMs = 6000,
}: SnapshotFrameProps): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [failed, setFailed] = useState(false);
  const onDocumentReadyRef = useRef(onDocumentReady);
  onDocumentReadyRef.current = onDocumentReady;
  const onFallbackRef = useRef(onFallback);
  onFallbackRef.current = onFallback;

  useEffect(() => {
    setFailed(html === null);
    if (html === null) {
      onDocumentReadyRef.current(null);
      onFallbackRef.current?.('the snapshot file could not be loaded');
    }
  }, [html]);

  useEffect(() => {
    if (html === null) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    let settled = false;

    const check = () => {
      if (settled) return;
      const doc = safeDocument(iframe);
      // A snapshot that parsed to an empty document is a failed render, not a slow one.
      if (doc?.body && doc.body.childElementCount > 0) {
        settled = true;
        clearTimeout(timer);
        onDocumentReadyRef.current(doc);
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      setFailed(true);
      onDocumentReadyRef.current(null);
      onFallbackRef.current?.('the snapshot did not render in time');
    }, readyTimeoutMs);

    iframe.addEventListener('load', check);
    // srcdoc can be parsed before React attaches the listener.
    check();
    const poll = setInterval(check, 120);

    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      iframe.removeEventListener('load', check);
    };
  }, [html, readyTimeoutMs]);

  const stageStyle: React.CSSProperties = {
    width: fit.captured.width,
    height: fit.captured.height,
    transform: `translate(${fit.offsetX}px, ${fit.offsetY}px) scale(${fit.scale})`,
    transformOrigin: 'top left',
  };

  if (failed || html === null) {
    return (
      <div className="dp-stage" style={stageStyle} data-testid="snapshot-fallback">
        <img className="dp-fallback-image" src={fallbackImageUrl} alt={title} draggable={false} />
      </div>
    );
  }

  return (
    <div className="dp-stage" style={stageStyle}>
      <iframe
        ref={iframeRef}
        className="dp-snapshot"
        title={title}
        srcDoc={html}
        // No allow-scripts. Same-origin only, so the overlay can read the document.
        sandbox="allow-same-origin"
        scrolling="no"
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  );
}

function safeDocument(iframe: HTMLIFrameElement): Document | null {
  try {
    return iframe.contentDocument;
  } catch {
    return null;
  }
}
