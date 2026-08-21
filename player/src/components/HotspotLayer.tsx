import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { resolveSelector, type Hotspot } from '@demo-platform/shared';
import { fallbackRect, toOverlayRect, type Fit, type Rect } from '../geometry.js';
import { Beacon } from './Beacon.js';
import { Tooltip } from './Tooltip.js';

/**
 * The overlay above the snapshot (SPEC §6).
 *
 * Hotspot positions resolve by querying the selector inside the snapshot document and
 * translating the result into overlay coordinates. Selector first, normalised
 * coordinates as fallback — that is what makes a hotspot survive a resize instead of
 * drifting off its button (§4).
 */

export interface HotspotLayerProps {
  hotspots: Hotspot[];
  activeIndex: number;
  /** Null when the step is on the fallback-image path; every anchor then uses coords. */
  snapshotDoc: Document | null;
  fit: Fit;
  container: { width: number; height: number };
  stepLabel: string;
  canGoBack: boolean;
  isLastStep: boolean;
  /** Called with the hotspot the visitor acted on, or with no argument for a step that has none. */
  onAdvance: (hotspot?: Hotspot) => void;
  onBack: () => void;
}

interface Resolved {
  hotspot: Hotspot;
  rect: Rect;
  anchoredBy: 'selector' | 'coordinates';
}

export function HotspotLayer({
  hotspots,
  activeIndex,
  snapshotDoc,
  fit,
  container,
  stepLabel,
  canGoBack,
  isLastStep,
  onAdvance,
  onBack,
}: HotspotLayerProps): React.ReactElement | null {
  const [resolved, setResolved] = useState<Resolved[]>([]);
  const autoFiredRef = useRef<string | null>(null);

  const resolve = useCallback(() => {
    setResolved(
      hotspots.map((hotspot) => {
        const element = snapshotDoc ? resolveSelector(snapshotDoc, hotspot.anchor.selector) : null;
        if (element) {
          const box = element.getBoundingClientRect();
          if (box.width > 0 || box.height > 0) {
            const view = element.ownerDocument.defaultView;
            return {
              hotspot,
              anchoredBy: 'selector' as const,
              rect: toOverlayRect(
                {
                  x: box.left + (view?.scrollX ?? 0),
                  y: box.top + (view?.scrollY ?? 0),
                  width: box.width,
                  height: box.height,
                },
                fit,
              ),
            };
          }
        }
        return {
          hotspot,
          anchoredBy: 'coordinates' as const,
          rect: fallbackRect(hotspot.anchorFallback, fit),
        };
      }),
    );
  }, [fit, hotspots, snapshotDoc]);

  // Re-resolve on fit change (resize) and once after layout settles: web fonts and
  // late-loading images inside the snapshot can move an anchor by a few pixels.
  useLayoutEffect(() => {
    resolve();
    const raf = requestAnimationFrame(resolve);
    const settle = setTimeout(resolve, 250);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
  }, [resolve]);

  const active = resolved[activeIndex];

  // trigger: 'auto' advances on its own after autoAdvanceMs (default 2.5s).
  useEffect(() => {
    if (!active || active.hotspot.trigger !== 'auto') return;
    if (autoFiredRef.current === active.hotspot.hotspotId) return;
    const delay = active.hotspot.autoAdvanceMs ?? 2500;
    const timer = setTimeout(() => {
      autoFiredRef.current = active.hotspot.hotspotId;
      onAdvance(active.hotspot);
    }, delay);
    return () => clearTimeout(timer);
  }, [active, onAdvance]);

  if (resolved.length === 0) {
    return (
      <div className="dp-overlay dp-overlay--empty">
        <Tooltip
          anchor={{ x: container.width / 2 - 20, y: container.height - 160, width: 40, height: 40 }}
          container={container}
          preference="top"
          title={stepLabel}
          body="Continue to the next step."
          nextLabel={isLastStep ? 'Finish' : 'Next'}
          canGoBack={canGoBack}
          onNext={() => onAdvance()}
          onBack={onBack}
        />
      </div>
    );
  }

  return (
    <div className="dp-overlay">
      {resolved.map((entry, index) => {
        const isActive = index === activeIndex;
        const trigger = entry.hotspot.trigger;
        return (
          <button
            key={entry.hotspot.hotspotId}
            type="button"
            className={`dp-hotspot${isActive ? ' is-active' : ''}`}
            style={{
              left: entry.rect.x,
              top: entry.rect.y,
              width: entry.rect.width,
              height: entry.rect.height,
            }}
            data-anchored-by={entry.anchoredBy}
            data-testid={`hotspot-${entry.hotspot.hotspotId}`}
            aria-label={entry.hotspot.tooltip.title || 'Continue'}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onAdvance(entry.hotspot)}
            onMouseEnter={trigger === 'hover' && isActive ? () => onAdvance(entry.hotspot) : undefined}
          >
            {isActive ? <Beacon /> : null}
          </button>
        );
      })}

      {active ? (
        <Tooltip
          anchor={active.rect}
          container={container}
          preference={active.hotspot.tooltip.position}
          title={active.hotspot.tooltip.title}
          body={active.hotspot.tooltip.body}
          nextLabel={isLastStep && activeIndex === resolved.length - 1 ? 'Finish' : 'Next'}
          canGoBack={canGoBack}
          onNext={() => onAdvance(active.hotspot)}
          onBack={onBack}
        />
      ) : null}
    </div>
  );
}
