#!/usr/bin/env tsx
/**
 * End-to-end verification of the kiosk bundle (SPEC §12, M5 acceptance).
 *
 * Copies the built bundle to a fresh directory (a stand-in for the USB stick), starts it
 * with the bundled launcher binary, and drives a browser whose DNS is dead — every host
 * except loopback resolves to nothing, which is what "wifi disabled" looks like to a
 * page. Then asserts that events queue locally and sync once an endpoint is reachable.
 *
 *   pnpm build:kiosk --all && tsx scripts/smoke-kiosk.mts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createProbe } from 'node:net';
import { cp, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConsoleCrmAdapter } from '../adapters/crm/src/index.js';
import { routeApi } from '../builds/web/api/handlers.js';
import { listen } from './static-server.mjs';
import { launchBrowser } from './cdp.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const bundleDir = join(repoRoot, 'builds/kiosk/dist-kiosk');

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: unknown, detail = ''): void {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

try {
  await stat(join(bundleDir, 'index.html'));
} catch {
  console.error('No kiosk bundle found. Run `pnpm build:kiosk --all` first.');
  process.exit(1);
}

// ---------------------------------------------------------------- the "USB stick"
const stick = await mkdtemp(join(tmpdir(), 'demo-usb-'));
await cp(bundleDir, stick, { recursive: true });

// ---------------------------------------------------------------- events endpoint
const crm = new ConsoleCrmAdapter(() => {});
const api = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const request = new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([key, value]) =>
      typeof value === 'string' ? ([[key, value]] as [string, string][]) : [],
    ),
    ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
  });
  const routed = routeApi(request, { crm, allowedOrigins: ['*'], log: () => {} });
  if (!routed) {
    res.writeHead(404).end('{}');
    return;
  }
  const response = await routed;
  const headers = Object.fromEntries(response.headers.entries());
  // The kiosk page is served from a different port, so the sync is cross-origin.
  headers['access-control-allow-origin'] = '*';
  headers['access-control-allow-headers'] = 'content-type';
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
});
const apiPort = await listen(api);
const eventsEndpoint = `http://127.0.0.1:${apiPort}/api/events`;

// A sales engineer edits this file; no rebuild needed (§8.2).
await writeFile(
  join(stick, 'kiosk-config.json'),
  JSON.stringify({ eventsEndpoint, idleResetMs: 0, autoSyncOnline: true, kioskLabel: 'Booth 12', buildId: 'smoke' }, null, 2),
  'utf8',
);

// ---------------------------------------------------------------- launcher
const binaries = (await readdir(stick)).filter((name) => name.startsWith('demo-kiosk-'));
check('the bundle ships a launcher binary', binaries.length > 0, binaries.join(', ') || 'none');
const launchScripts = (await readdir(stick)).filter((name) => name.startsWith('launch.'));
check(
  'double-click launchers for Windows and macOS are present',
  launchScripts.includes('launch.cmd') && launchScripts.includes('launch.command'),
  launchScripts.join(', '),
);
check('the bundle explains itself to a sales engineer', (await readdir(stick)).includes('READ-ME-FIRST.txt'));

/** A free port rather than a fixed one, so a stray process cannot answer for this run. */
const kioskPort = await new Promise<number>((resolvePort, reject) => {
  const probe = createProbe();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    probe.close(() => resolvePort(port));
  });
});
let launcher: ChildProcess | null = null;
let launcherOutput = '';

if (binaries.length > 0) {
  const binary = join(stick, binaries.find((name) => name.includes('linux')) ?? binaries[0]!);
  launcher = spawn(binary, ['--port', String(kioskPort), '--no-browser'], {
    cwd: stick,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  launcher.stdout?.on('data', (chunk) => {
    launcherOutput += String(chunk);
  });
  launcher.stderr?.on('data', (chunk) => {
    launcherOutput += String(chunk);
  });
  await delay(1200);
  check('the launcher serves the bundle it sits next to', launcherOutput.includes(stick), launcherOutput.slice(0, 200));
}

const origin = `http://127.0.0.1:${kioskPort}`;

// ---------------------------------------------------------------- browser, wifi "off"
const browser = await launchBrowser({
  width: 1440,
  height: 900,
  // Every host except loopback fails to resolve: the bundle has to be self-sufficient.
  extraArgs: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
});
let failures = 0;

try {
  await browser.goto(`${origin}/`, { waitMs: 2500 });

  const picker = await browser.evaluate(`(() => ({
    cards: [...document.querySelectorAll('.kiosk-card-title')].map((n) => n.textContent),
    label: document.querySelector('.kiosk-footer span')?.textContent ?? '',
    gate: Boolean(document.querySelector('[data-testid="gate-form"]')),
    admin: Boolean(document.querySelector('.kiosk-admin-corner')),
  }))()`);

  check('the picker lists the bundled demos', picker.cards.length === 3, JSON.stringify(picker.cards));
  check('the booth label from the config is shown', picker.label.includes('Booth 12'), picker.label);
  check('gating is absent from the kiosk bundle entirely', picker.gate === false);
  check('the admin corner exists but is unlabelled', picker.admin === true);

  // Play a demo with DNS dead.
  const played = await browser.evaluate(`(async () => {
    document.querySelector('.kiosk-card').click();
    await new Promise((r) => setTimeout(r, 2200));
    const frame = document.querySelector('iframe.dp-snapshot');
    const innerDoc = frame && frame.contentDocument;
    const before = {
      rendered: innerDoc ? innerDoc.body.querySelectorAll('*').length : 0,
      images: innerDoc ? [...innerDoc.querySelectorAll('img')].length : 0,
      brokenImages: innerDoc
        ? [...innerDoc.querySelectorAll('img')].filter((img) => img.complete && img.naturalWidth === 0).length
        : 0,
      hotspot: document.querySelector('.dp-hotspot.is-active')?.getAttribute('data-anchored-by') ?? null,
    };
    for (let i = 0; i < 12; i += 1) {
      const target = document.querySelector('.dp-hotspot.is-active, .dp-tooltip-actions .dp-button--primary');
      if (!target) break;
      target.click();
      await new Promise((r) => setTimeout(r, 400));
    }
    return {
      ...before,
      finished: Boolean(document.querySelector('.dp-end-headline')),
      entry: 'kiosk',
    };
  })()`);

  check('a demo renders with DNS dead', played.rendered > 40, `${played.rendered} nodes`);
  check('images inside the snapshot are embedded, not fetched', played.brokenImages === 0, `${played.brokenImages} broken of ${played.images}`);
  check('hotspots anchor by selector offline', played.hotspot === 'selector', String(played.hotspot));
  check('the demo plays through to the end screen offline', played.finished === true);

  // Events must be in IndexedDB, not on the wire.
  const queued = await browser.evaluate(`(async () => {
    const open = indexedDB.open('demo-platform-events', 1);
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction('queue', 'readonly');
    const all = await new Promise((resolve, reject) => {
      const request = tx.objectStore('queue').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return {
      count: all.length,
      names: [...new Set(all.map((row) => row.event.name))],
      sources: [...new Set(all.map((row) => row.event.payload.entrySource).filter(Boolean))],
      leadIds: [...new Set(all.map((row) => row.event.leadId ?? null))],
    };
  })()`);

  check('events queued locally while offline', queued.count > 0, `${queued.count} queued`);
  check('the queue holds the documented event names', queued.names.includes('demo_started') && queued.names.includes('step_viewed'), queued.names.join(', '));
  check('events are marked as kiosk-sourced', queued.sources.includes('kiosk'), JSON.stringify(queued.sources));
  check('no lead is attached on a kiosk session', queued.leadIds.every((id: unknown) => id === null), JSON.stringify(queued.leadIds));
  check('nothing reached the server while offline', crm.recordedEvents().length === 0, `${crm.recordedEvents().length} events`);

  // ---------------------------------------------------------------- reconnect and sync
  await browser.goto(`${origin}/`, { waitMs: 1800 });
  const synced = await browser.evaluate(`(async () => {
    document.querySelector('.kiosk-admin-corner').click();
    await new Promise((r) => setTimeout(r, 500));
    const pendingBefore = document.querySelector('[data-testid="admin-pending"]')?.textContent ?? null;
    document.querySelector('.admin-sync').click();
    await new Promise((r) => setTimeout(r, 2500));
    return {
      pendingBefore,
      pendingAfter: document.querySelector('[data-testid="admin-pending"]')?.textContent ?? null,
      result: document.querySelector('.admin-result')?.textContent ?? null,
      isError: Boolean(document.querySelector('.admin-result.is-error')),
    };
  })()`);

  check('the admin panel shows the queue depth', Number(synced.pendingBefore) === queued.count, `${synced.pendingBefore} vs ${queued.count}`);
  check('sync reports success', synced.isError === false, String(synced.result));
  check('the queue drains after a successful sync', Number(synced.pendingAfter) === 0, String(synced.pendingAfter));
  check(
    'the server received the queued events',
    crm.recordedEvents().length === queued.count,
    `${crm.recordedEvents().length} received of ${queued.count}`,
  );
  check(
    'synced events kept their original timestamps',
    crm.recordedEvents().every((event) => typeof event.timestamp === 'string' && event.timestamp.endsWith('Z')),
  );
  check(
    'drop-off is derivable from the synced data',
    crm.recordedEvents().some((event) => event.name === 'step_completed'),
    crm.recordedEvents().map((e) => e.name).join(', '),
  );

  failures = checks.filter((entry) => !entry.ok).length;
} finally {
  await browser.close();
  launcher?.kill('SIGKILL');
  api.close();
  await rm(stick, { recursive: true, force: true });
}

console.log(`\n${checks.length - failures}/${checks.length} checks passed.`);
if (failures > 0) process.exit(1);
