/**
 * Layout arithmetic for the player overlay (SPEC §6).
 *
 * The snapshot renders at its captured size inside an iframe; the player scales that
 * iframe to fit the viewport and letterboxes it rather than reflowing — a reflowed
 * snapshot would move every hotspot and misrepresent the product. All of it is pure so
 * the maths is unit-tested rather than eyeballed at a tradeshow.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Fit {
  /** Multiplier applied to the iframe via CSS transform. */
  scale: number;
  /** Letterbox offset of the scaled snapshot inside the container. */
  offsetX: number;
  offsetY: number;
  /** Rendered size of the scaled snapshot. */
  renderedWidth: number;
  renderedHeight: number;
  captured: Size;
}

/**
 * Scale-to-fit with letterboxing. Never scales above 1: an upscaled snapshot looks
 * blurry and a prospect reads that as a low-quality product.
 */
export function computeFit(container: Size, captured: Size, { allowUpscale = false } = {}): Fit {
  const safeCaptured: Size = {
    width: captured.width > 0 ? captured.width : 1440,
    height: captured.height > 0 ? captured.height : 900,
  };
  const raw = Math.min(container.width / safeCaptured.width, container.height / safeCaptured.height);
  const scale = Number.isFinite(raw) && raw > 0 ? (allowUpscale ? raw : Math.min(raw, 1)) : 1;
  const renderedWidth = safeCaptured.width * scale;
  const renderedHeight = safeCaptured.height * scale;
  return {
    scale,
    offsetX: Math.max(0, (container.width - renderedWidth) / 2),
    offsetY: Math.max(0, (container.height - renderedHeight) / 2),
    renderedWidth,
    renderedHeight,
    captured: safeCaptured,
  };
}

/** Translate a rect measured inside the snapshot document into overlay coordinates. */
export function toOverlayRect(inner: Rect, fit: Fit): Rect {
  return {
    x: fit.offsetX + inner.x * fit.scale,
    y: fit.offsetY + inner.y * fit.scale,
    width: Math.max(1, inner.width * fit.scale),
    height: Math.max(1, inner.height * fit.scale),
  };
}

/**
 * Overlay rect for a normalised (0..1) fallback coordinate. Used when the selector does
 * not resolve, and always when a step has fallen back to its image (§4).
 */
export function fallbackRect(
  point: { x: number; y: number },
  fit: Fit,
  size = 44,
): Rect {
  const centreX = fit.offsetX + point.x * fit.renderedWidth;
  const centreY = fit.offsetY + point.y * fit.renderedHeight;
  return { x: centreX - size / 2, y: centreY - size / 2, width: size, height: size };
}

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';
export type TooltipPreference = TooltipPosition | 'auto';

export interface Placement {
  position: TooltipPosition;
  x: number;
  y: number;
}

const GAP = 14;
const EDGE = 12;

/**
 * Place a tooltip against an anchor, collision-aware.
 *
 * `auto` tries below → above → right → left and takes the first side that fits; if none
 * fit, it keeps the side with the most room and clamps into the container. An explicit
 * preference is honoured when it fits and falls back to `auto` behaviour when it does not,
 * because a tooltip half off-screen is worse than one on an unexpected side.
 */
export function placeTooltip(
  anchor: Rect,
  tooltip: Size,
  container: Size,
  preference: TooltipPreference = 'auto',
): Placement {
  const order: TooltipPosition[] =
    preference === 'auto'
      ? ['bottom', 'top', 'right', 'left']
      : [preference, ...(['bottom', 'top', 'right', 'left'] as TooltipPosition[]).filter((p) => p !== preference)];

  const candidates = order.map((position) => ({ position, ...coordsFor(position, anchor, tooltip) }));

  const fits = candidates.find(
    (candidate) =>
      candidate.x >= EDGE &&
      candidate.y >= EDGE &&
      candidate.x + tooltip.width <= container.width - EDGE &&
      candidate.y + tooltip.height <= container.height - EDGE,
  );

  const chosen = fits ?? candidates[0]!;
  return {
    position: chosen.position,
    x: clamp(chosen.x, EDGE, Math.max(EDGE, container.width - tooltip.width - EDGE)),
    y: clamp(chosen.y, EDGE, Math.max(EDGE, container.height - tooltip.height - EDGE)),
  };
}

function coordsFor(position: TooltipPosition, anchor: Rect, tooltip: Size): { x: number; y: number } {
  const centreX = anchor.x + anchor.width / 2 - tooltip.width / 2;
  const centreY = anchor.y + anchor.height / 2 - tooltip.height / 2;
  switch (position) {
    case 'top':
      return { x: centreX, y: anchor.y - tooltip.height - GAP };
    case 'bottom':
      return { x: centreX, y: anchor.y + anchor.height + GAP };
    case 'left':
      return { x: anchor.x - tooltip.width - GAP, y: centreY };
    case 'right':
      return { x: anchor.x + anchor.width + GAP, y: centreY };
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Below this width the player shows the image walkthrough instead (§6). */
export const DESKTOP_FLOOR_PX = 1024;

export function isBelowDesktopFloor(width: number): boolean {
  return width > 0 && width < DESKTOP_FLOOR_PX;
}
