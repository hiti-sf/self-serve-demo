import { describe, expect, it } from 'vitest';
import { sliceOffsets, toPixelRect } from '../src/lib/crop.js';

describe('sliceOffsets', () => {
  it('covers a page that is an exact multiple of the viewport', () => {
    expect(sliceOffsets(1800, 900)).toEqual([0, 900]);
  });

  it('clamps the last slice to the bottom edge instead of scrolling past it', () => {
    expect(sliceOffsets(2000, 900)).toEqual([0, 900, 1100]);
  });

  it('handles a page shorter than the viewport', () => {
    expect(sliceOffsets(500, 900)).toEqual([0]);
  });

  it('never returns an empty list', () => {
    expect(sliceOffsets(0, 900)).toEqual([0]);
    expect(sliceOffsets(900, 0)).toEqual([0]);
  });
});

describe('toPixelRect', () => {
  const bounds = { width: 2880, height: 4200 };

  it('scales CSS pixels by the device pixel ratio', () => {
    expect(toPixelRect({ x: 100, y: 200, width: 400, height: 300 }, 2, bounds)).toEqual({
      x: 200,
      y: 400,
      width: 800,
      height: 600,
    });
  });

  it('clips a region that runs past the screenshot', () => {
    const rect = toPixelRect({ x: 1400, y: 2090, width: 200, height: 200 }, 2, bounds);
    expect(rect).toEqual({ x: 2800, y: 4180, width: 80, height: 20 });
  });

  it('returns null for a region entirely outside the screenshot', () => {
    expect(toPixelRect({ x: 4000, y: 0, width: 100, height: 100 }, 2, bounds)).toBeNull();
  });

  it('defaults a bad ratio to 1', () => {
    expect(toPixelRect({ x: 10, y: 10, width: 10, height: 10 }, 0, bounds)).toEqual({
      x: 10,
      y: 10,
      width: 10,
      height: 10,
    });
  });
});
