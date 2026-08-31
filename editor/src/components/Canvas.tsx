import { useCallback, useEffect, useRef, useState } from 'react';
import { computeFit, toOverlayRect, type Fit } from '@demo-platform/player';
import { resolveSelector, type Hotspot } from '@demo-platform/shared';
import { describeElement, startPicker, type PickedAnchor } from '../lib/anchor-picker.js';
import { serialiseForExport, startTextEditing } from '../lib/text-edit.js';
import type { EditorStep } from '../state/project.js';

export type CanvasMode = 'inspect' | 'place-hotspot' | 'edit-text';

export interface CanvasProps {
  step: EditorStep;
  mode: CanvasMode;
  selectedHotspotId: string | null;
  onPick: (pick: PickedAnchor) => void;
  onSelectHotspot: (hotspotId: string) => void;
  onSnapshotEdited: (html: string) => void;
  onMoveHotspot: (hotspotId: string, pick: PickedAnchor) => void;
}

/**
 * The authoring canvas (SPEC §7).
 *
 * Renders the snapshot the same way the player does — a sandboxed, script-free iframe
 * scaled to fit — so what the author places a hotspot on is what a prospect will see. The
 * three modes are the three things an author does to a step: look at it, put a hotspot on
 * it, or fix its text.
 */
export function Canvas({
  step,
  mode,
  selectedHotspotId,
  onPick,
  onSelectHotspot,
  onSnapshotEdited,
  onMoveHotspot,
}: CanvasProps): React.ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [container, setContainer] = useState({ width: 0, height: 0 });
  const [unresolved, setUnresolved] = useState<string[]>([]);

  /**
   * The HTML handed to the iframe, refreshed only when the step changes.
   *
   * Text editing writes every keystroke back into project state. If `srcDoc` tracked that
   * directly, the iframe would reload on each character and take the caret with it, so the
   * live document is the source of truth while editing and the project is updated from it.
   */
  const [srcDoc, setSrcDoc] = useState(step.snapshotHtml);
  useEffect(() => {
    setSrcDoc(step.snapshotHtml);
    // Intentionally keyed on the step, not the html.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.stepId]);

  const onSnapshotEditedRef = useRef(onSnapshotEdited);
  onSnapshotEditedRef.current = onSnapshotEdited;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onMoveHotspotRef = useRef(onMoveHotspot);
  onMoveHotspotRef.current = onMoveHotspot;

  // Measure the stage.
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setContainer({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Wait for the new document. The iframe carries key={step.stepId}, so React gives us a
  // fresh element per step and `contentDocument` can only ever be about:blank (which has
  // no body children) or this step's document — never the previous step's.
  useEffect(() => {
    setDoc(null);
    const iframe = iframeRef.current;
    if (!iframe) return;
    let settled = false;
    const check = () => {
      if (settled) return;
      const candidate = iframe.contentDocument;
      if (candidate?.body && candidate.body.childElementCount > 0) {
        settled = true;
        setDoc(candidate);
      }
    };
    check();
    const poll = setInterval(check, 60);
    const stop = setTimeout(() => clearInterval(poll), 5000);
    return () => {
      clearInterval(poll);
      clearTimeout(stop);
    };
  }, [step.stepId, srcDoc]);

  const fit: Fit = computeFit(container, step.viewport);

  // Mode wiring. Each mode owns its listeners and removes every trace on teardown.
  useEffect(() => {
    if (!doc) return;

    if (mode === 'place-hotspot') {
      const picker = startPicker(doc, step.viewport, (pick) => {
        if (selectedHotspotId) onMoveHotspotRef.current(selectedHotspotId, pick);
        else onPickRef.current(pick);
      });
      return () => picker.stop();
    }

    if (mode === 'edit-text') {
      const editing = startTextEditing(doc, () => {
        // Serialise on every keystroke: the project state is the single source of
        // truth, and an unsaved iframe is how edits get lost on a step change.
        try {
          onSnapshotEditedRef.current(serialiseForExport(doc));
        } catch {
          /* a mid-edit document can be momentarily invalid; the next keystroke wins */
        }
      });
      return () => editing.stop();
    }

    return undefined;
  }, [doc, mode, selectedHotspotId, step.viewport]);

  // Report hotspots whose selector no longer resolves — usually after a text edit that
  // changed the element the selector depended on.
  useEffect(() => {
    if (!doc) {
      setUnresolved([]);
      return;
    }
    setUnresolved(
      step.hotspots
        .filter((hotspot) => !resolveSelector(doc, hotspot.anchor.selector))
        .map((hotspot) => hotspot.hotspotId),
    );
  }, [doc, step.hotspots]);

  const rectFor = useCallback(
    (hotspot: Hotspot) => {
      const element = doc ? resolveSelector(doc, hotspot.anchor.selector) : null;
      if (element) {
        const described = describeElement(element, step.viewport);
        if (described) return { rect: toOverlayRect(described.rect, fit), anchoredBy: 'selector' as const };
      }
      const size = 44;
      return {
        rect: {
          x: fit.offsetX + hotspot.anchorFallback.x * fit.renderedWidth - size / 2,
          y: fit.offsetY + hotspot.anchorFallback.y * fit.renderedHeight - size / 2,
          width: size,
          height: size,
        },
        anchoredBy: 'coordinates' as const,
      };
    },
    [doc, fit, step.viewport],
  );

  return (
    <div className={`canvas canvas--${mode}`} ref={wrapRef}>
      <div
        className="canvas-stage"
        style={{
          width: step.viewport.width,
          height: step.viewport.height,
          transform: `translate(${fit.offsetX}px, ${fit.offsetY}px) scale(${fit.scale})`,
          transformOrigin: 'top left',
        }}
      >
        <iframe
          key={step.stepId}
          ref={iframeRef}
          title={`${step.stepId} snapshot`}
          srcDoc={srcDoc}
          // Same sandbox as the player: no allow-scripts, same-origin so the editor can
          // read and edit the document from here.
          sandbox="allow-same-origin"
          scrolling="no"
          className={mode === 'inspect' ? 'is-inert' : ''}
        />
      </div>

      <div className="canvas-overlay">
        {step.hotspots.map((hotspot) => {
          const { rect, anchoredBy } = rectFor(hotspot);
          const isSelected = hotspot.hotspotId === selectedHotspotId;
          return (
            <button
              key={hotspot.hotspotId}
              type="button"
              className={`canvas-hotspot${isSelected ? ' is-selected' : ''}${
                anchoredBy === 'coordinates' ? ' is-unresolved' : ''
              }`}
              style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
              onClick={() => onSelectHotspot(hotspot.hotspotId)}
              title={`${hotspot.hotspotId} · ${hotspot.anchor.selector}`}
              data-testid={`canvas-hotspot-${hotspot.hotspotId}`}
              data-anchored-by={anchoredBy}
            >
              <span className="canvas-hotspot-label">{hotspot.hotspotId}</span>
            </button>
          );
        })}
      </div>

      {mode === 'place-hotspot' ? (
        <p className="canvas-hint">
          {selectedHotspotId
            ? `Click an element to re-anchor ${selectedHotspotId}.`
            : 'Click an element in the screen to place a hotspot on it.'}
        </p>
      ) : null}
      {mode === 'edit-text' ? (
        <p className="canvas-hint">
          Click any text to edit it. Enter is disabled and pasted markup is stripped, so the
          captured layout cannot break.
        </p>
      ) : null}
      {unresolved.length > 0 ? (
        <p className="canvas-warning" role="status">
          {unresolved.join(', ')} no longer match an element and will fall back to coordinates.
          Re-anchor them.
        </p>
      ) : null}
    </div>
  );
}
