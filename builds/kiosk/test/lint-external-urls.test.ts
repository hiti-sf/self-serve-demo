import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain-JS build tooling, no types needed
import { lintBundle } from '../scripts/lint-external-urls.mjs';

/**
 * The kiosk guarantee is "no network at runtime", and this lint is what enforces it
 * (SPEC §8.2). These tests are as much about the false-positive cases as the true ones:
 * a lint that cries wolf on base64 payloads gets switched off, and then the guarantee
 * is gone.
 */

const allowedHosts = new Set(['www.w3.org', 'react.dev', 'pivotpath.example']);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kiosk-lint-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<void> {
  const path = join(dir, name);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function lint() {
  return lintBundle(dir, { allowedHosts }) as Promise<{
    failures: { rel: string; label: string; url: string; why: string }[];
    informational: { rel: string; url: string }[];
    scanned: number;
  }>;
}

describe('kiosk bundle lint — blocks what would hit the network', () => {
  it('fails a CDN script tag', async () => {
    await write('index.html', '<script src="https://cdn.example/app.js"></script>');
    const { failures } = await lint();
    // One URL, reported once, under the most specific label.
    expect(failures).toHaveLength(1);
    expect(failures[0]?.label).toBe('element src');
    expect(failures[0]?.why).toContain('loadable position');
  });

  it('fails a remote stylesheet', async () => {
    await write('index.html', '<link rel="stylesheet" href="https://fonts.example/x.css">');
    expect((await lint()).failures.some((f) => f.label === '<link href>')).toBe(true);
  });

  it('fails a remote font in CSS', async () => {
    await write('assets/app.css', '@font-face{src:url(https://fonts.gstatic.example/a.woff2)}');
    const { failures } = await lint();
    expect(failures.some((f) => f.label === 'CSS url()')).toBe(true);
  });

  it('fails a fetch to an external host', async () => {
    await write('assets/app.js', 'fetch("https://analytics.example/collect",{method:"POST"})');
    expect((await lint()).failures.some((f) => f.label === 'fetch()')).toBe(true);
  });

  it('fails a dynamic import from a CDN', async () => {
    await write('assets/app.js', 'const m = await import("https://esm.example/lib.js");');
    expect((await lint()).failures.some((f) => f.label === 'dynamic import()')).toBe(true);
  });

  it('fails a WebSocket connection', async () => {
    await write('assets/app.js', 'const s = new WebSocket("wss://live.example/socket");');
    expect((await lint()).failures.some((f) => f.label === 'WebSocket')).toBe(true);
  });

  it('fails a remote image', async () => {
    await write('index.html', '<img src="https://images.example/hero.png">');
    expect((await lint()).failures.some((f) => f.label === 'element src')).toBe(true);
  });

  it('fails an undeclared host even in a harmless-looking position', async () => {
    await write('assets/app.js', 'const doc = "https://telemetry.example/docs";');
    const { failures } = await lint();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.label).toBe('undeclared external URL');
    expect(failures[0]?.why).toContain('telemetry.example');
  });
});

describe('kiosk bundle lint — passes what is genuinely offline-safe', () => {
  it('passes a fully embedded bundle', async () => {
    await write('index.html', '<img src="data:image/gif;base64,AAA"><script src="./assets/app.js"></script>');
    await write('assets/app.css', '.a{background:url("./bg.png")}');
    await write('assets/app.js', 'fetch("./demos/index.json")');
    const { failures, scanned } = await lint();
    expect(failures).toEqual([]);
    expect(scanned).toBe(3);
  });

  it('does not flag base64 payloads that happen to contain a double slash', async () => {
    await write('snapshots/step-01.html', '<img src="data:image/png;base64,iVBORw0KGgoAAAA//Cw8PDw==">');
    expect((await lint()).failures).toEqual([]);
  });

  it('does not flag a regex literal followed by .test()', async () => {
    await write('assets/app.js', 'if (/^a\\/\\//i.test(value)) return value;');
    expect((await lint()).failures).toEqual([]);
  });

  it('does not flag loopback, which is how the launcher serves the bundle', async () => {
    await write('serve.mjs', 'console.log(`http://127.0.0.1:${port}/`); const u = "http://localhost/";');
    expect((await lint()).failures).toEqual([]);
  });

  it('does not flag a declared host', async () => {
    await write('assets/app.js', 'const ns = "http://www.w3.org/2000/svg"; const help = "https://react.dev/errors/1";');
    expect((await lint()).failures).toEqual([]);
  });

  it('allows an end-screen CTA target — the visitor clicks it, nothing fetches it', async () => {
    await write(
      'demos/inlumin/flow-01/manifest.json',
      JSON.stringify({ endScreen: { cta: { label: 'Book', url: 'https://booking.partner.example/x' } } }),
    );
    expect((await lint()).failures).toEqual([]);
  });

  it('allows capture provenance attributes on a snapshot', async () => {
    await write(
      'snapshots/step-01.html',
      '<html data-demo-source-url="https://inlumin.tenant.example/requisitions"><a href="#" data-demo-original-href="https://inlumin.tenant.example/po/44">PO</a></html>',
    );
    expect((await lint()).failures).toEqual([]);
  });

  it('reports the operator-configured sync endpoint instead of failing on it', async () => {
    await write('kiosk-config.json', JSON.stringify({ eventsEndpoint: 'https://demo.pivotpath.example/api/events' }));
    const { failures, informational } = await lint();
    expect(failures).toEqual([]);
    expect(informational).toHaveLength(1);
    expect(informational[0]?.url).toContain('demo.pivotpath.example');
  });

  it('ignores source maps and binary assets', async () => {
    await write('assets/app.js.map', '{"sources":["https://cdn.example/x.js"]}');
    const { failures, scanned } = await lint();
    expect(failures).toEqual([]);
    expect(scanned).toBe(0);
  });
});
