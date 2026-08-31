import { describe, expect, it } from 'vitest';
import {
  computeFit,
  fallbackRect,
  isBelowDesktopFloor,
  placeTooltip,
  toOverlayRect,
} from '../src/geometry.js';

const captured = { width: 1440, height: 900 };

describe('computeFit', () => {
  it('letterboxes horizontally when the container is wider than the capture', () => {
    const fit = computeFit({ width: 1600, height: 900 }, captured);
    expect(fit.scale).toBe(1);
    expect(fit.offsetX).toBe(80);
    expect(fit.offsetY).toBe(0);
  });

  it('scales down to fit a smaller container', () => {
    const fit = computeFit({ width: 720, height: 900 }, captured);
    expect(fit.scale).toBeCloseTo(0.5);
    expect(fit.renderedWidth).toBeCloseTo(720);
    expect(fit.renderedHeight).toBeCloseTo(450);
    expect(fit.offsetY).toBeCloseTo(225);
  });

  it('never upscales by default, so a snapshot is never blurry', () => {
    expect(computeFit({ width: 2880, height: 1800 }, captured).scale).toBe(1);
    expect(computeFit({ width: 2880, height: 1800 }, captured, { allowUpscale: true }).scale).toBe(2);
  });

  it('falls back to a sane capture size when the manifest has none', () => {
    const fit = computeFit({ width: 1440, height: 900 }, { width: 0, height: 0 });
    expect(fit.captured).toEqual({ width: 1440, height: 900 });
  });

  it('survives a zero-size container during first layout', () => {
    const fit = computeFit({ width: 0, height: 0 }, captured);
    expect(Number.isFinite(fit.scale)).toBe(true);
    expect(fit.scale).toBeGreaterThan(0);
  });
});

describe('toOverlayRect', () => {
  it('maps snapshot coordinates through scale and letterbox offset', () => {
    const fit = computeFit({ width: 720, height: 900 }, captured);
    const rect = toOverlayRect({ x: 100, y: 200, width: 120, height: 40 }, fit);
    expect(rect.x).toBeCloseTo(50);
    expect(rect.y).toBeCloseTo(225 + 100);
    expect(rect.width).toBeCloseTo(60);
    expect(rect.height).toBeCloseTo(20);
  });

  it('keeps a hotspot on the same element after a resize', () => {
    const inner = { x: 1000, y: 300, width: 80, height: 32 };
    const wide = toOverlayRect(inner, computeFit({ width: 1440, height: 900 }, captured));
    const narrow = toOverlayRect(inner, computeFit({ width: 720, height: 450 }, captured));
    // Same fraction of the rendered snapshot in both layouts.
    expect((wide.x - 0) / 1440).toBeCloseTo((narrow.x - 0) / 720, 4);
  });
});

describe('fallbackRect', () => {
  it('centres a target on the normalised coordinate', () => {
    const fit = computeFit({ width: 1440, height: 900 }, captured);
    const rect = fallbackRect({ x: 0.5, y: 0.5 }, fit, 40);
    expect(rect.x).toBeCloseTo(700);
    expect(rect.y).toBeCloseTo(430);
  });

  it('accounts for letterboxing', () => {
    const fit = computeFit({ width: 1600, height: 900 }, captured);
    expect(fallbackRect({ x: 0, y: 0 }, fit, 40).x).toBeCloseTo(80 - 20);
  });
});

describe('placeTooltip', () => {
  const container = { width: 1200, height: 800 };
  const tooltip = { width: 320, height: 140 };

  it('prefers below the anchor', () => {
    const placement = placeTooltip({ x: 400, y: 300, width: 100, height: 40 }, tooltip, container);
    expect(placement.position).toBe('bottom');
    expect(placement.y).toBeGreaterThan(340);
  });

  it('flips above when there is no room below', () => {
    const placement = placeTooltip({ x: 400, y: 720, width: 100, height: 40 }, tooltip, container);
    expect(placement.position).toBe('top');
  });

  it('honours an explicit preference that fits', () => {
    const placement = placeTooltip(
      { x: 600, y: 400, width: 100, height: 40 },
      tooltip,
      container,
      'left',
    );
    expect(placement.position).toBe('left');
  });

  it('overrides a preference that would run off the stage', () => {
    const placement = placeTooltip({ x: 20, y: 400, width: 60, height: 40 }, tooltip, container, 'left');
    expect(placement.position).not.toBe('left');
    expect(placement.x).toBeGreaterThanOrEqual(12);
  });

  it('always clamps inside the container', () => {
    for (const anchor of [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 1190, y: 790, width: 10, height: 10 },
      { x: 600, y: 400, width: 10, height: 10 },
    ]) {
      const placement = placeTooltip(anchor, tooltip, container);
      expect(placement.x).toBeGreaterThanOrEqual(12);
      expect(placement.y).toBeGreaterThanOrEqual(12);
      expect(placement.x + tooltip.width).toBeLessThanOrEqual(container.width - 11);
      expect(placement.y + tooltip.height).toBeLessThanOrEqual(container.height - 11);
    }
  });
});

describe('isBelowDesktopFloor', () => {
  it('draws the line at 1024px', () => {
    expect(isBelowDesktopFloor(1023)).toBe(true);
    expect(isBelowDesktopFloor(1024)).toBe(false);
    expect(isBelowDesktopFloor(0)).toBe(false);
  });
});
