// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Hotspot } from '@demo-platform/shared';
import { HotspotLayer } from '../src/components/HotspotLayer.js';
import { computeFit } from '../src/geometry.js';

// Vitest runs without globals, so testing-library's auto-cleanup is not installed.
afterEach(cleanup);

const container = { width: 1440, height: 900 };
const fit = computeFit(container, { width: 1440, height: 900 });

function hotspot(overrides: Partial<Hotspot> = {}): Hotspot {
  return {
    hotspotId: 'hs-01',
    anchor: { selector: '#save-po', strategy: 'css' },
    anchorFallback: { x: 0.5, y: 0.25 },
    trigger: 'click',
    tooltip: { title: 'Save the PO', body: 'Commit the requisition.', position: 'auto' },
    ...overrides,
  } as Hotspot;
}

/** A snapshot document with one anchorable element at a known position. */
function snapshotDoc(html: string, rects: Record<string, DOMRect | undefined> = {}): Document {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const [selector, rect] of Object.entries(rects)) {
    const element = doc.querySelector(selector);
    if (element && rect) {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
    }
  }
  return doc;
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('HotspotLayer anchoring', () => {
  it('anchors to the resolved selector, not the fallback coordinates', () => {
    const doc = snapshotDoc('<body><button id="save-po">Save</button></body>', {
      '#save-po': rect(1000, 300, 120, 40),
    });

    render(
      <HotspotLayer
        hotspots={[hotspot()]}
        activeIndex={0}
        snapshotDoc={doc}
        fit={fit}
        container={container}
        stepLabel="Raise a requisition"
        canGoBack={false}
        isLastStep={false}
        onAdvance={() => {}}
        onBack={() => {}}
      />,
    );

    const element = screen.getByTestId('hotspot-hs-01');
    expect(element.dataset.anchoredBy).toBe('selector');
    expect(element.style.left).toBe('1000px');
    expect(element.style.top).toBe('300px');
    expect(element.style.width).toBe('120px');
  });

  it('falls back to normalised coordinates when the selector no longer matches', () => {
    const doc = snapshotDoc('<body><button id="renamed">Save</button></body>');

    render(
      <HotspotLayer
        hotspots={[hotspot()]}
        activeIndex={0}
        snapshotDoc={doc}
        fit={fit}
        container={container}
        stepLabel="Raise a requisition"
        canGoBack={false}
        isLastStep={false}
        onAdvance={() => {}}
        onBack={() => {}}
      />,
    );

    const element = screen.getByTestId('hotspot-hs-01');
    expect(element.dataset.anchoredBy).toBe('coordinates');
    // 0.5 × 1440 − 22 = 698 ; 0.25 × 900 − 22 = 203
    expect(element.style.left).toBe('698px');
    expect(element.style.top).toBe('203px');
  });

  it('uses coordinates for every hotspot when the step is on the fallback image', () => {
    render(
      <HotspotLayer
        hotspots={[hotspot(), hotspot({ hotspotId: 'hs-02', anchorFallback: { x: 0.2, y: 0.8 } })]}
        activeIndex={0}
        snapshotDoc={null}
        fit={fit}
        container={container}
        stepLabel="Raise a requisition"
        canGoBack={false}
        isLastStep={false}
        onAdvance={() => {}}
        onBack={() => {}}
      />,
    );

    expect(screen.getByTestId('hotspot-hs-01').dataset.anchoredBy).toBe('coordinates');
    expect(screen.getByTestId('hotspot-hs-02').dataset.anchoredBy).toBe('coordinates');
  });

  it('re-anchors through the scale factor when the container shrinks', () => {
    const doc = snapshotDoc('<body><button id="save-po">Save</button></body>', {
      '#save-po': rect(1000, 300, 120, 40),
    });
    const half = computeFit({ width: 720, height: 450 }, { width: 1440, height: 900 });

    render(
      <HotspotLayer
        hotspots={[hotspot()]}
        activeIndex={0}
        snapshotDoc={doc}
        fit={half}
        container={{ width: 720, height: 450 }}
        stepLabel="Raise a requisition"
        canGoBack={false}
        isLastStep={false}
        onAdvance={() => {}}
        onBack={() => {}}
      />,
    );

    const element = screen.getByTestId('hotspot-hs-01');
    expect(element.style.left).toBe('500px');
    expect(element.style.width).toBe('60px');
  });

  it('reports the acted-on hotspot to the host', () => {
    const onAdvance = vi.fn();
    const doc = snapshotDoc('<body><button id="save-po">Save</button></body>', {
      '#save-po': rect(10, 10, 40, 40),
    });

    render(
      <HotspotLayer
        hotspots={[hotspot()]}
        activeIndex={0}
        snapshotDoc={doc}
        fit={fit}
        container={container}
        stepLabel="Raise"
        canGoBack={false}
        isLastStep={false}
        onAdvance={onAdvance}
        onBack={() => {}}
      />,
    );

    screen.getByTestId('hotspot-hs-01').click();
    expect(onAdvance).toHaveBeenCalledWith(expect.objectContaining({ hotspotId: 'hs-01' }));
  });

  it('still offers a way forward on a step with no hotspots', () => {
    const onAdvance = vi.fn();
    render(
      <HotspotLayer
        hotspots={[]}
        activeIndex={0}
        snapshotDoc={null}
        fit={fit}
        container={container}
        stepLabel="Spend summary"
        canGoBack
        isLastStep
        onAdvance={onAdvance}
        onBack={() => {}}
      />,
    );

    expect(screen.getByTestId('tooltip')).toBeTruthy();
    screen.getByRole('button', { name: 'Finish' }).click();
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('renders the tooltip copy from the manifest', () => {
    render(
      <HotspotLayer
        hotspots={[hotspot()]}
        activeIndex={0}
        snapshotDoc={null}
        fit={fit}
        container={container}
        stepLabel="Raise"
        canGoBack={false}
        isLastStep={false}
        onAdvance={() => {}}
        onBack={() => {}}
      />,
    );
    expect(screen.getByText('Save the PO')).toBeTruthy();
    expect(screen.getByText('Commit the requisition.')).toBeTruthy();
  });
});
