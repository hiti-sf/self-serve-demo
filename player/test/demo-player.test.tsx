// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseManifest, type Manifest } from '@demo-platform/shared';
import { DemoPlayer } from '../src/DemoPlayer.js';
import { ConsoleTransport } from '../src/analytics/transport.js';

afterEach(cleanup);

const SNAPSHOT_ONE = `<!DOCTYPE html><html><body><main><button id="new-requisition">New requisition</button></main></body></html>`;
const SNAPSHOT_TWO = `<!DOCTYPE html><html><body><main><button id="submit-requisition">Submit</button></main></body></html>`;

function manifest(): Manifest {
  return parseManifest({
    schemaVersion: '1.0',
    demoId: 'inlumin-flow-01',
    product: 'InLumin',
    title: 'Requisition to approved PO',
    theme: { primaryColor: '#20A676' },
    settings: { gated: false, showProgress: true, showChapterMenu: true, keyboardNav: true },
    chapters: [
      { chapterId: 'ch-01', title: 'Raise a requisition', steps: ['step-01', 'step-02'] },
      { chapterId: 'ch-02', title: 'Approve', steps: ['step-03'] },
    ],
    steps: [
      {
        stepId: 'step-01',
        snapshot: 'snapshots/step-01.html',
        fallbackImage: 'snapshots/step-01.png',
        viewport: { width: 1440, height: 900 },
        hotspots: [
          {
            hotspotId: 'hs-01',
            anchor: { selector: '#new-requisition', strategy: 'css' },
            anchorFallback: { x: 0.2, y: 0.15 },
            trigger: 'click',
            tooltip: { title: 'Start here', body: 'Raise a requisition.', position: 'auto' },
            advancesTo: 'step-02',
          },
        ],
      },
      {
        stepId: 'step-02',
        // Deliberately broken below, to exercise the fallback-image path (§4, M2).
        snapshot: 'snapshots/step-02.html',
        fallbackImage: 'snapshots/step-02.png',
        viewport: { width: 1440, height: 900 },
        hotspots: [
          {
            hotspotId: 'hs-02',
            anchor: { selector: '#submit-requisition', strategy: 'css' },
            anchorFallback: { x: 0.6, y: 0.4 },
            trigger: 'click',
            tooltip: { title: 'Submit', body: 'Send it for approval.', position: 'auto' },
            advancesTo: 'step-03',
          },
        ],
      },
      {
        stepId: 'step-03',
        snapshot: 'snapshots/step-03.html',
        fallbackImage: 'snapshots/step-03.png',
        viewport: { width: 1440, height: 900 },
        hotspots: [],
      },
    ],
    endScreen: {
      headline: 'See it on your own spend data',
      cta: { label: 'Book a walkthrough', url: 'https://pivotpath.example/book' },
      secondaryCta: { label: 'Explore another product', url: 'https://pivotpath.example/products' },
    },
  });
}

/** step-02's snapshot 404s; everything else resolves. */
function fetchImpl(broken: string[] = ['snapshots/step-02.html']) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (broken.some((path) => url.endsWith(path))) return new Response('', { status: 404 });
    if (url.endsWith('step-01.html')) return new Response(SNAPSHOT_ONE);
    if (url.endsWith('step-02.html')) return new Response(SNAPSHOT_TWO);
    if (url.endsWith('.html')) return new Response('<!DOCTYPE html><html><body><p>step</p></body></html>');
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

function renderPlayer(overrides: Partial<React.ComponentProps<typeof DemoPlayer>> = {}) {
  const transport = new ConsoleTransport();
  const utils = render(
    <DemoPlayer
      manifest={manifest()}
      resolve={(path) => `http://demo.local/d/${path}`}
      transport={transport}
      entrySource="web"
      analyticsEnabled
      fetchImpl={fetchImpl()}
      {...overrides}
    />,
  );
  return { transport, ...utils };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('DemoPlayer', () => {
  it('plays the first step and shows its tooltip', async () => {
    renderPlayer();
    expect(await screen.findByText('Start here')).toBeTruthy();
    expect(screen.getByText('Step 1 of 3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Raise a requisition' })).toBeTruthy();
  });

  it('falls back to the step image when the snapshot cannot be loaded', async () => {
    renderPlayer();

    // Advance to step-02, whose snapshot 404s.
    (await screen.findByText('Start here')).ownerDocument
      .querySelector<HTMLButtonElement>('[data-testid="hotspot-hs-01"]')!
      .click();

    const fallback = await screen.findByTestId('snapshot-fallback');
    expect(fallback.querySelector('img')?.getAttribute('src')).toBe(
      'http://demo.local/d/snapshots/step-02.png',
    );
    expect(screen.getByText('Showing a static image for this step.')).toBeTruthy();
    // The demo keeps playing: the hotspot is still there, anchored by coordinates.
    expect(screen.getByTestId('hotspot-hs-02').dataset.anchoredBy).toBe('coordinates');
  });

  it('emits the documented event sequence', async () => {
    const { transport } = renderPlayer();
    await screen.findByText('Start here');

    screen.getByTestId('hotspot-hs-01').click();
    await screen.findByText('Submit');

    const names = transport.all().map((event) => event.name);
    expect(names[0]).toBe('demo_started');
    expect(names).toContain('step_viewed');
    expect(names).toContain('step_completed');

    const started = transport.all()[0]!;
    expect(started.payload).toMatchObject({ entrySource: 'web' });
    expect(started.sessionId).toMatch(/^ses_/);
    expect(transport.all().every((event) => event.demoId === 'inlumin-flow-01')).toBe(true);
  });

  it('fires chapter_completed when the demo crosses a chapter boundary', async () => {
    const { transport } = renderPlayer();
    await screen.findByText('Start here');

    screen.getByTestId('hotspot-hs-01').click();
    await screen.findByText('Submit');
    screen.getByTestId('hotspot-hs-02').click();

    await waitFor(() =>
      expect(transport.all().map((event) => event.name)).toContain('chapter_completed'),
    );
    const chapterEvent = transport.all().find((event) => event.name === 'chapter_completed')!;
    expect(chapterEvent.payload).toEqual({ chapterId: 'ch-01' });
  });

  it('reaches the end screen and reports demo_completed and cta_clicked', async () => {
    const { transport } = renderPlayer();
    await screen.findByText('Start here');

    screen.getByTestId('hotspot-hs-01').click();
    await screen.findByText('Submit');
    screen.getByTestId('hotspot-hs-02').click();

    // step-03 has no hotspots: the tooltip's Finish button ends the demo.
    const finish = await screen.findByRole('button', { name: 'Finish' });
    finish.click();

    const cta = await screen.findByRole('link', { name: 'Book a walkthrough' });
    expect(screen.getByText('See it on your own spend data')).toBeTruthy();

    cta.click();
    await waitFor(() => {
      const names = transport.all().map((event) => event.name);
      expect(names).toContain('demo_completed');
      expect(names).toContain('cta_clicked');
    });
    const completed = transport.all().find((event) => event.name === 'demo_completed')!;
    expect(completed.payload).toHaveProperty('totalMs');
  });

  it('fires nothing at all before consent', async () => {
    const { transport } = renderPlayer({ analyticsEnabled: false });
    await screen.findByText('Start here');
    screen.getByTestId('hotspot-hs-01').click();
    await screen.findByText('Submit');
    expect(transport.all()).toEqual([]);
  });

  it('carries leadId on every event once the gate is submitted', async () => {
    const { transport } = renderPlayer({ leadId: 'lead_42' });
    await screen.findByText('Start here');
    await waitFor(() => expect(transport.all().length).toBeGreaterThan(0));
    expect(transport.all().every((event) => event.leadId === 'lead_42')).toBe(true);
  });

  it('navigates with the keyboard', async () => {
    renderPlayer();
    await screen.findByText('Start here');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(await screen.findByText('Submit')).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(await screen.findByText('Start here')).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await screen.findByRole('dialog', { name: 'Chapters' })).toBeTruthy();
  });

  it('jumps to a chapter from the chapter menu', async () => {
    renderPlayer();
    await screen.findByText('Start here');

    screen.getByRole('button', { name: 'Raise a requisition' }).click();
    const menu = await screen.findByRole('dialog', { name: 'Chapters' });
    menu.querySelectorAll('button')[2]?.click();

    await waitFor(() => expect(screen.getByText('Step 3 of 3')).toBeTruthy());
  });

  it('shows the mobile walkthrough below the desktop floor', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 820, configurable: true });
    try {
      renderPlayer();
      expect(await screen.findByText(/best viewed on a desktop screen/)).toBeTruthy();
      expect(screen.getAllByRole('img').length).toBe(3);
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
    }
  });
});
