import { describe, expect, it, vi } from 'vitest';
import { DemoLoadError, loadDemo, loadSnapshotHtml } from '../src/loader/loadDemo.js';

const manifest = {
  schemaVersion: '1.0',
  demoId: 'inlumin-flow-01',
  product: 'InLumin',
  title: 'Requisition to PO',
  chapters: [{ chapterId: 'ch-01', title: 'Raise', steps: ['step-01'] }],
  steps: [{ stepId: 'step-01', snapshot: 'snapshots/step-01.html', fallbackImage: 'snapshots/step-01.png' }],
  endScreen: { headline: 'Next step', cta: { label: 'Book', url: 'https://example.com' } },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('loadDemo', () => {
  it('loads and validates a manifest, resolving paths relative to the folder', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(manifest));
    const bundle = await loadDemo('http://kiosk.local/demos/inlumin/flow-01', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith('http://kiosk.local/demos/inlumin/flow-01/manifest.json');
    expect(bundle.manifest.demoId).toBe('inlumin-flow-01');
    expect(bundle.resolve('snapshots/step-01.html')).toBe(
      'http://kiosk.local/demos/inlumin/flow-01/snapshots/step-01.html',
    );
  });

  it('reports a missing demo folder clearly', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    await expect(loadDemo('http://kiosk.local/demos/ghost', { fetchImpl })).rejects.toThrow(DemoLoadError);
  });

  it('lists validation issues so an author can fix the manifest', async () => {
    const broken = { ...manifest, chapters: [{ chapterId: 'ch-01', title: 'x', steps: ['nope'] }] };
    const fetchImpl = vi.fn(async () => jsonResponse(broken));
    await expect(loadDemo('http://kiosk.local/d', { fetchImpl })).rejects.toMatchObject({
      name: 'DemoLoadError',
    });

    try {
      await loadDemo('http://kiosk.local/d', { fetchImpl });
    } catch (error) {
      expect((error as DemoLoadError).detail.join('\n')).toContain('unknown stepId');
    }
  });

  it('refuses a manifest from a newer major schema version with an actionable message', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ...manifest, schemaVersion: '2.0' }));
    try {
      await loadDemo('http://kiosk.local/d', { fetchImpl });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).toContain('2.0');
      expect((error as Error).message).toContain('Update the player');
    }
  });
});

describe('loadSnapshotHtml', () => {
  it('returns the html for a healthy snapshot', async () => {
    const fetchImpl = vi.fn(async () => new Response('<!DOCTYPE html><html><body>hi</body></html>'));
    expect(await loadSnapshotHtml('http://x/s.html', { fetchImpl })).toContain('<body>hi</body>');
  });

  it('returns null on a 404 so the step falls back to its image', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
    expect(await loadSnapshotHtml('http://x/s.html', { fetchImpl })).toBeNull();
  });

  it('returns null on a network failure rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await loadSnapshotHtml('http://x/s.html', { fetchImpl })).toBeNull();
  });

  it('treats an empty file as a failed snapshot', async () => {
    const fetchImpl = vi.fn(async () => new Response('   '));
    expect(await loadSnapshotHtml('http://x/s.html', { fetchImpl })).toBeNull();
  });
});
