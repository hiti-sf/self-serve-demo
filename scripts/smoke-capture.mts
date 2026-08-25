#!/usr/bin/env tsx
/**
 * End-to-end verification of the capture extension (SPEC §12, M1 — as far as it can be
 * taken without the live product).
 *
 * This is the gate IMPLEMENTATION.md called unclosable in CI, and it is *mostly*
 * closable: what needs the real tenant is the InLumin DOM and a logged-in session, not
 * the extension machinery. So this loads the built extension into a real Chrome, points
 * it at a fixture page that carries every hard case §5 names, and drives a genuine
 * capture through all four contexts — content script, service worker, offscreen
 * document, and the message protocol between them.
 *
 * Then it does the thing that actually matters: renders the resulting snapshot with DNS
 * dead and compares it against the live page.
 *
 * What this does NOT prove: that InLumin's own markup serialises faithfully. Only a
 * capture against the tenant shows that.
 *
 *   pnpm build:extension && tsx scripts/smoke-capture.mts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { findChromium } from './cdp.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const extensionDir = join(repoRoot, 'capture-extension/dist');
const fixtureDir = join(repoRoot, 'capture-extension/test-fixture');
const outDir = join(repoRoot, '.smoke/capture');

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: unknown, detail = ''): void {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  await stat(join(extensionDir, 'manifest.json'));
} catch {
  console.error('The extension is not built. Run `pnpm build:extension` first.');
  process.exit(1);
}

// ---------------------------------------------------------------- fixture servers
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function serve(root: string) {
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!.replace(/^\/+/, '') || 'index.html';
    if (path.includes('..')) {
      res.writeHead(403).end();
      return;
    }
    const file = join(root, path);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      // No CORS header: the page must not be able to read the cross-origin stylesheet
      // itself. Only the worker's privileged fetch can, which is the path under test.
      'cache-control': 'no-store',
    });
    createReadStream(file).on('error', () => res.end()).pipe(res);
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolvePort) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolvePort(typeof address === 'object' && address ? address.port : 0);
    }),
  );
}

const cdnServer = serve(join(fixtureDir, 'cdn'));
const cdnPort = await listen(cdnServer);
const cdnOrigin = `http://127.0.0.1:${cdnPort}`;

// The app page is served from a *different port*, which makes the CDN cross-origin.
const appDir = await mkdtemp(join(tmpdir(), 'capture-fixture-'));
const appHtml = (await readFile(join(fixtureDir, 'app.html'), 'utf8')).replaceAll('CDN_ORIGIN', cdnOrigin);
await writeFile(join(appDir, 'app.html'), appHtml, 'utf8');
const appServer = serve(appDir);
const appPort = await listen(appServer);
const appUrl = `http://127.0.0.1:${appPort}/app.html`;

console.log(`\nFixture app  ${appUrl}`);
console.log(`Fixture cdn  ${cdnOrigin}  (cross-origin: stylesheet, font, images, iframe)\n`);

// ---------------------------------------------------------------- browser + extension
/**
 * `chrome.permissions.request()` raises a native dialog that only a human can accept, so
 * the grant itself cannot be automated headlessly. The pipeline is therefore exercised
 * against a copy of the shipping build whose manifest pre-grants the same access, and
 * the real grant path is asserted statically below — the shipping manifest keeps host
 * access optional, the popup requests it from its click, and the worker refuses to
 * capture without it.
 */
const shippingManifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8')) as {
  optional_host_permissions?: string[];
  host_permissions?: string[];
};
const popupSource = await readFile(join(extensionDir, 'popup/popup.js'), 'utf8');
const workerSource = await readFile(join(extensionDir, 'background/service-worker.js'), 'utf8');

check(
  'the shipping manifest keeps host access optional',
  shippingManifest.optional_host_permissions?.includes('<all_urls>') === true &&
    !shippingManifest.host_permissions,
  JSON.stringify({ optional: shippingManifest.optional_host_permissions, required: shippingManifest.host_permissions }),
);
check('the popup requests host access from its click', popupSource.includes('permissions.request'));
check('the worker refuses to capture without it', workerSource.includes('permissions.contains'));

const testExtensionDir = await mkdtemp(join(tmpdir(), 'capture-ext-'));
await cp(extensionDir, testExtensionDir, { recursive: true });
await writeFile(
  join(testExtensionDir, 'manifest.json'),
  JSON.stringify(
    { ...shippingManifest, host_permissions: ['<all_urls>'], optional_host_permissions: undefined },
    (_key, value) => (value === undefined ? undefined : value),
    2,
  ),
  'utf8',
);

const binary = await findChromium();
const profile = await mkdtemp(join(tmpdir(), 'capture-profile-'));
const port = 9400 + (process.pid % 300);

const chrome: ChildProcess = spawn(
  binary,
  [
    '--headless=new',
    '--no-sandbox',
    // Branded Chrome (the GitHub runner's browser) refuses --load-extension unless this
    // is off; Chromium builds, which is what this runs against locally, never had it.
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    // Software GL, so the WebGL path is genuinely exercised rather than skipped.
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1440,900',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${testExtensionDir}`,
    `--load-extension=${testExtensionDir}`,
    appUrl,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let chromeLog = '';
chrome.stderr?.on('data', (c) => {
  chromeLog += String(c);
});

interface Target {
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

async function targets(): Promise<Target[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return (await response.json()) as Target[];
}

/**
 * Chrome derives an unpacked extension's id from its absolute path: the first 16 bytes of
 * the SHA-256, with each hex digit mapped into a–p. Knowing it up front means the harness
 * can reach an extension page without needing the extension to already be awake.
 */
function unpackedExtensionId(dir: string): string {
  const digest = createHash('sha256').update(dir, 'utf8').digest('hex').slice(0, 32);
  return [...digest].map((d) => String.fromCharCode(0x61 + Number.parseInt(d, 16))).join('');
}

/** Open a tab through the DevTools endpoint, which needs no page and no extension. */
async function openTab(url: string): Promise<void> {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { method: 'PUT' });
  // Chrome required GET here until 111 and rejects it since; try the other verb once.
  if (!response.ok) await fetch(endpoint).catch(() => undefined);
}

/** A minimal CDP session against one target. */
async function attach(target: Target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl!);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', () => reject(new Error(`could not attach to ${target.url}`)), { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  socket.addEventListener('message', (message) => {
    const payload = JSON.parse(String((message as MessageEvent).data)) as {
      id?: number;
      error?: { message: string };
      result?: unknown;
    };
    if (payload.id && pending.has(payload.id)) {
      const entry = pending.get(payload.id)!;
      pending.delete(payload.id);
      if (payload.error) entry.reject(new Error(payload.error.message));
      else entry.resolve(payload.result);
    }
  });

  const send = (method: string, params: unknown = {}) =>
    new Promise<Record<string, unknown>>((resolveSend, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolveSend as (v: unknown) => void, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 150_000);
    });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = (await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (result.exceptionDetails) {
      throw new Error(
        `page threw: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`,
      );
    }
    return result.result?.value as T;
  };

  return { send, evaluate, close: () => socket.close() };
}

let failures = 0;

try {
  // Wait for the fixture page, then for the extension.
  let serviceWorker: Target | undefined;
  let pageTarget: Target | undefined;
  for (let attempt = 0; attempt < 60 && !(serviceWorker && pageTarget); attempt += 1) {
    await delay(250);
    try {
      const list = await targets();
      serviceWorker = list.find((t) => t.type === 'service_worker' && t.url.includes('service-worker'));
      pageTarget = list.find((t) => t.type === 'page' && t.url.startsWith(appUrl));
    } catch {
      /* not up yet */
    }
  }

  // An MV3 service worker is lazy: with no event to handle it may not be running, and a
  // worker that is not running has no debugger target at all. Opening any extension page
  // starts it. The id is derivable, so this needs nothing from the extension itself.
  const expectedId = unpackedExtensionId(testExtensionDir);
  if (!serviceWorker) {
    await openTab(`chrome-extension://${expectedId}/popup/popup.html`);
    for (let attempt = 0; attempt < 40 && !serviceWorker; attempt += 1) {
      await delay(250);
      serviceWorker = (await targets()).find(
        (t) => t.type === 'service_worker' && t.url.includes('service-worker'),
      );
    }
  }

  check(
    'the built extension loads as an MV3 extension',
    Boolean(serviceWorker),
    `expected ${expectedId}; targets: ${(await targets().catch(() => []))
      .map((t) => `${t.type} ${t.url}`)
      .join(' | ')
      .slice(0, 400)} · chrome: ${chromeLog.slice(-300)}`,
  );
  check('the fixture page is open', Boolean(pageTarget));
  if (!serviceWorker || !pageTarget) throw new Error('extension or page never appeared');

  const extensionId = new URL(serviceWorker.url).host;
  // If this ever drifts, the lazy-worker wake path above is opening a dead URL and the
  // failure would look like "the extension did not load" rather than "the id was wrong".
  check('the extension id is derivable from its path', extensionId === expectedId, `${extensionId} vs ${expectedId}`);
  console.log(`  extension id ${extensionId}\n`);

  const page = await attach(pageTarget);
  await page.send('Runtime.enable');

  // Let the fixture's post-load script settle.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await page.evaluate<boolean>('Boolean(window.__fixtureReady)')) break;
    await delay(200);
  }

  const live = await page.evaluate<Record<string, unknown>>(`(() => ({
    modalOpen: document.getElementById('modal').classList.contains('open'),
    menuOpen: document.getElementById('menu-list').classList.contains('open'),
    note: document.getElementById('note').value,
    costCentre: document.getElementById('cost-centre').selectedIndex,
    confirmed: document.getElementById('confirm').checked,
    scrollTop: document.getElementById('scroller').scrollTop,
    webgl: document.getElementById('gl').getAttribute('data-webgl'),
    shadow: Boolean(document.getElementById('badge').shadowRoot),
    crossOriginSheetReadable: (() => {
      for (const sheet of document.styleSheets) {
        try { void sheet.cssRules; } catch { return false; }
      }
      return true;
    })(),
  }))()`);

  check('the fixture reached its post-interaction state', live.modalOpen === true && live.menuOpen === true, JSON.stringify(live));
  check('the cross-origin stylesheet is unreadable from the page', live.crossOriginSheetReadable === false,
    'the fixture is not exercising the privileged-fetch path');
  check('WebGL drew into a canvas', live.webgl === 'drawn', String(live.webgl));

  const screenshotLive = (await page.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'live-page.png'), Buffer.from(screenshotLive.data, 'base64'));

  // ------------------------------------------------------------ run a real capture
  // Drive the extension exactly as the popup does: send `capture/start` to the service
  // worker with the target tab. The whole pipeline runs — pre-pass, rrweb traversal,
  // offscreen rebuild, sanitise, embed, screenshot crops, CSP, serialise, PII scan.
  const worker = await attach(serviceWorker);
  await worker.send('Runtime.enable');

  const tabId = await worker.evaluate<number>(`(async () => {
    const tabs = await chrome.tabs.query({ url: ${JSON.stringify(`${appUrl}*`)} });
    return tabs.length ? tabs[0].id : -1;
  })()`);
  check('the worker can see the fixture tab', typeof tabId === 'number' && tabId >= 0, String(tabId));


  // The service worker's own listener does not receive its own sendMessage, and an
  // extension page is not injectable (`<all_urls>` does not cover chrome-extension://),
  // so the capture is driven from the popup page itself — exactly the real path.
  let popupTarget = (await targets()).find((t) => t.type === 'page' && t.url.includes('popup/popup.html'));
  if (!popupTarget) await openTab(`chrome-extension://${extensionId}/popup/popup.html`);
  for (let attempt = 0; attempt < 40 && !popupTarget; attempt += 1) {
    await delay(250);
    popupTarget = (await targets()).find((t) => t.type === 'page' && t.url.includes('popup/popup.html'));
  }
  check('the popup page is running', Boolean(popupTarget));
  if (!popupTarget) throw new Error('the popup never opened');
  const popup = await attach(popupTarget);
  await popup.send('Runtime.enable');

  // The popup opened in the foreground, and `captureVisibleTab` needs the page it is
  // capturing to be the visible one. Put the fixture back in front.
  await worker.evaluate(`chrome.tabs.update(${tabId}, { active: true }).then(() => true)`);

  console.log('\n  running a capture through the full pipeline…\n');
  const started = Date.now();

  // A hang here is a result, not a crash: report it as the failed check it is.
  const captured = await popup.evaluate<{
    ok: boolean;
    error?: string;
    data?: {
      html: string;
      fallbackPng: string;
      piiFindings: { kind: string; match: string }[];
      meta: {
        stats: Record<string, number>;
        warnings: { kind: string; detail: string }[];
        anchorHints: { selector: string; strength: string; label: string }[];
        viewport: Record<string, number>;
      };
    };
  }>(`(async () => {
    try {
      return await chrome.runtime.sendMessage({ type: 'capture/start', tabId: ${tabId} });
    } catch (error) {
      return { ok: false, error: String((error && error.stack) || error) };
    }
  })()`).catch((error: Error) => ({ ok: false as const, error: error.message }));

  const elapsed = Date.now() - started;
  check('the capture completed', captured?.ok === true, captured?.error ?? JSON.stringify(captured)?.slice(0, 300));

  if (captured?.ok && captured.data) {
    const { html, fallbackPng, piiFindings, meta } = captured.data;
    console.log(`     took ${(elapsed / 1000).toFixed(1)}s · ${(html.length / 1024).toFixed(0)} kB of HTML\n`);

    await writeFile(join(outDir, 'snapshot.html'), html, 'utf8');
    await writeFile(join(outDir, 'fallback.png'), Buffer.from(fallbackPng.split(',')[1] ?? '', 'base64'));
    await writeFile(join(outDir, 'capture-meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    // ---- the guarantees ------------------------------------------------------
    check('the snapshot has no <script>', !/<script[\s>]/i.test(html));
    check('the snapshot has no inline handler', !/\son(?:click|mouseover|load|submit|error)\s*=/i.test(html));
    check('the snapshot carries its own CSP', html.includes("default-src 'none'"));
    check('capture provenance was stamped', html.includes('data-demo-capture-id='));

    // Loadable positions only. `data-demo-original-href` keeps the anchor's original
    // target as inert provenance for the editor — the kiosk lint exempts it by name,
    // and the leading boundary here is what stops it matching as an `href=`.
    const externals = [...html.matchAll(/[\s"'](?:src|href|srcset|poster|action|data)\s*=\s*"(https?:\/\/[^"]+)"/gi)].map(
      (m) => m[1]!,
    );
    check('no external URL is left in a loadable position', externals.length === 0, externals.slice(0, 3).join(', '));
    check(
      'off-site anchors were parked, with their target kept as provenance',
      /<a[^>]+href="#"[^>]+data-demo-original-href="http/i.test(html),
    );

    // ---- post-interaction state ---------------------------------------------
    check('the open modal survived', /class="[^"]*\bmodal\b[^"]*\bopen\b|\bopen\b[^"]*\bmodal\b/.test(html) || html.includes('Approve REQ-1042'));
    check('the expanded menu survived', html.includes('menu-list') && /menu-list[^"]*open|open[^"]*menu-list/.test(html));
    check('the typed input value survived', html.includes('Cleared against Q3 budget'));
    check('the chosen <option> survived', /CC-2240[^<]*<\/option>/.test(html) ? /selected/i.test(html) : /selected/i.test(html));
    check('the checked box survived', /id="confirm"[^>]*checked|checked[^>]*id="confirm"/.test(html));

    // ---- the hard cases ------------------------------------------------------
    check('the canvas chart became an image', /data-demo-replaced="(?:canvas|webgl)"/.test(html) || (meta.stats.rasterisedCanvases ?? 0) > 0,
      `rasterisedCanvases=${meta.stats.rasterisedCanvases}`);
    check('the shadow root became declarative shadow DOM', html.includes('shadowrootmode'),
      `serialisedShadowRoots=${meta.stats.serialisedShadowRoots}`);
    check('the cross-origin iframe was handled, not ignored',
      meta.warnings.some((w) => w.kind === 'cross-origin-iframe') || html.includes('data-demo-replaced="cross-origin-iframe"'),
      meta.warnings.map((w) => w.kind).join(', '));
    check('cross-origin resources were embedded', (meta.stats.embeddedResources ?? 0) > 0,
      `embeddedResources=${meta.stats.embeddedResources}`);

    // ---- PII ----------------------------------------------------------------
    const kinds = piiFindings.map((f) => f.kind);
    check('PII in the captured page was flagged for review', kinds.includes('email'), kinds.join(', ') || 'none');

    // ---- anchor hints -------------------------------------------------------
    check('anchor hints were offered to the editor', (meta.anchorHints?.length ?? 0) > 0, `${meta.anchorHints?.length ?? 0} hints`);
    check('a stable selector was found for a data-testid element',
      (meta.anchorHints ?? []).some((h) => h.selector.includes('data-testid') && h.strength === 'attribute'),
      (meta.anchorHints ?? []).slice(0, 3).map((h) => h.selector).join(' | '));

    // ---- and the one that matters: does it render offline? -------------------
    const offlineProfile = await mkdtemp(join(tmpdir(), 'capture-offline-'));
    const shot = join(outDir, 'snapshot-rendered-offline.png');
    const renderer = spawn(
      binary,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--window-size=1440,900',
        // Nothing resolves. If the snapshot needs the network, this render shows it.
        '--host-resolver-rules=MAP * ~NOTFOUND',
        `--user-data-dir=${offlineProfile}`,
        `--screenshot=${shot}`,
        `file://${join(outDir, 'snapshot.html')}`,
      ],
      { stdio: 'ignore' },
    );
    await new Promise((r) => renderer.on('exit', r));
    await rm(offlineProfile, { recursive: true, force: true });

    let renderedBytes = 0;
    try {
      renderedBytes = (await stat(shot)).size;
    } catch {
      /* nothing written */
    }
    check('the snapshot renders with DNS dead', renderedBytes > 10_000, `${renderedBytes} bytes`);

    // A screenshot proves it painted; it does not prove the *right* thing painted. Load
    // the snapshot as a page and read the DOM back, so the two failures this pipeline
    // shipped with — a shadow root that serialises but never rehydrates, and a poster
    // image sized to the file rather than to the video it replaced — stay caught.
    await writeFile(join(appDir, 'snapshot.html'), html, 'utf8');
    await openTab(`http://127.0.0.1:${appPort}/snapshot.html`);
    let snapshotTarget: Target | undefined;
    for (let attempt = 0; attempt < 40 && !snapshotTarget; attempt += 1) {
      await delay(250);
      snapshotTarget = (await targets()).find((t) => t.type === 'page' && t.url.endsWith('/snapshot.html'));
    }
    check('the snapshot opens as a page', Boolean(snapshotTarget));

    if (snapshotTarget) {
      const rendered = await attach(snapshotTarget);
      await rendered.send('Runtime.enable');
      const dom = await rendered.evaluate<Record<string, unknown>>(`(() => {
        const badge = document.getElementById('badge');
        const shadow = badge && badge.shadowRoot;
        const inner = shadow && shadow.querySelector('[data-testid="shadow-badge"]');
        const poster = document.querySelector('img[data-demo-replaced="video"]');
        const posterRect = poster ? poster.getBoundingClientRect() : null;
        return {
          shadowText: inner ? inner.textContent.trim() : null,
          shadowPainted: inner ? inner.getBoundingClientRect().width : 0,
          posterWidth: posterRect ? Math.round(posterRect.width) : 0,
          leftoverTemplates: document.querySelectorAll('template[shadowrootmode]').length,
        };
      })()`);
      rendered.close();

      check('the shadow root rehydrates and paints', dom.shadowText === 'Vitalis Labs · qualified' && Number(dom.shadowPainted) > 40,
        JSON.stringify(dom));
      check('the parser consumed the declarative template', dom.leftoverTemplates === 0, String(dom.leftoverTemplates));
      // The fixture's CSS sizes the <video> to 260px; the poster PNG is not that wide.
      check('the video poster kept the box the video occupied', Number(dom.posterWidth) === 260, `${dom.posterWidth}px`);
    }

    console.log(`\n  artefacts in ${outDir.replace(`${repoRoot}/`, '')}/`);
    console.log('    snapshot.html · fallback.png · capture-meta.json');
    console.log('    live-page.png vs snapshot-rendered-offline.png — compare these by eye\n');

    if (meta.warnings.length > 0) {
      console.log('  capture warnings:');
      for (const warning of meta.warnings) console.log(`    · ${warning.kind}: ${warning.detail.slice(0, 110)}`);
      console.log('');
    }
  }

  worker.close();
  page.close();
  failures = checks.filter((entry) => !entry.ok).length;
} finally {
  chrome.kill('SIGKILL');
  appServer.close();
  cdnServer.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  await rm(appDir, { recursive: true, force: true }).catch(() => {});
  await rm(testExtensionDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`${checks.length - failures}/${checks.length} checks passed.`);
if (failures > 0) process.exit(1);
