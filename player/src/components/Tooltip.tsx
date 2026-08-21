import { useLayoutEffect, useRef, useState } from 'react';
import { placeTooltip, type Rect, type Size, type TooltipPreference } from '../geometry.js';

export interface TooltipProps {
  anchor: Rect;
  container: Size;
  preference: TooltipPreference;
  title: string;
  body: string;
  nextLabel: string;
  canGoBack: boolean;
  onNext: () => void;
  onBack: () => void;
}

/**
 * Tooltip with collision-aware placement (SPEC §6). Measures itself, then asks
 * `placeTooltip` where to sit, so a hotspot near the bottom edge flips above instead of
 * hanging off the stage.
 */
export function Tooltip({
  anchor,
  container,
  preference,
  title,
  body,
  nextLabel,
  canGoBack,
  onNext,
  onBack,
}: TooltipProps): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 300, height: 132 });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && Math.abs(rect.width - size.width) + Math.abs(rect.height - size.height) > 1) {
      setSize({ width: rect.width, height: rect.height });
    }
  }, [body, size.height, size.width, title]);

  const placement = placeTooltip(anchor, size, container, preference);

  return (
    <div
      ref={ref}
      className={`dp-tooltip dp-tooltip--${placement.position}`}
      style={{ left: placement.x, top: placement.y }}
      role="dialog"
      aria-live="polite"
      aria-label={title || 'Demo step'}
      data-testid="tooltip"
    >
      {title ? <h2 className="dp-tooltip-title">{title}</h2> : null}
      {body ? <p className="dp-tooltip-body">{body}</p> : null}
      <div className="dp-tooltip-actions">
        <button
          type="button"
          className="dp-button dp-button--ghost"
          onClick={onBack}
          disabled={!canGoBack}
        >
          Back
        </button>
        <button type="button" className="dp-button dp-button--primary" onClick={onNext} autoFocus>
          {nextLabel}
        </button>
      </div>
    </div>
  );
}
