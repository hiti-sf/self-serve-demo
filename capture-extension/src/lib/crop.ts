/**
 * Geometry for pasting screenshot regions into a snapshot.
 *
 * The full-page fallback PNG is captured at devicePixelRatio, while crop requests are
 * recorded in CSS pixels. Kept pure so the arithmetic is unit-tested rather than
 * eyeballed against a booth laptop.
 */

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function toPixelRect(
  rect: { x: number; y: number; width: number; height: number },
  devicePixelRatio: number,
  bounds: { width: number; height: number },
): PixelRect | null {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const x = Math.max(0, Math.round(rect.x * ratio));
  const y = Math.max(0, Math.round(rect.y * ratio));
  const width = Math.min(Math.round(rect.width * ratio), bounds.width - x);
  const height = Math.min(Math.round(rect.height * ratio), bounds.height - y);
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Where each captured viewport slice lands in the stitched image. The last slice
 * overlaps the previous one when the page height is not a multiple of the viewport,
 * so it is drawn at the bottom edge rather than past it.
 */
export function sliceOffsets(documentHeight: number, viewportHeight: number): number[] {
  if (viewportHeight <= 0) return [0];
  const offsets: number[] = [];
  for (let y = 0; y < documentHeight; y += viewportHeight) {
    offsets.push(Math.min(y, Math.max(0, documentHeight - viewportHeight)));
  }
  return offsets.length > 0 ? [...new Set(offsets)] : [0];
}
