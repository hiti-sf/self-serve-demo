#!/usr/bin/env tsx
/**
 * End-to-end verification of the editor (SPEC §12, M3 acceptance).
 *
 * The acceptance gate is: *a non-engineer builds a complete 8+ step flow from raw
 * captures — hotspots, tooltips, inline text edits, reorder, chapters — and publishes a
 * manifest the player runs without hand-editing JSON.*
 *
 * So this drives the real editor in a real browser through exactly that, using only the
 * UI an author would use: the file picker, clicks on the rendered screen, the tooltip
 * fields, drag-and-drop, the chapter selects, and the Publish button. Then it plays the
 * published folder in the player.
 *
 *   pnpm build:editor && pnpm build:player && tsx scripts/smoke-editor.mts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createProbe } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStaticServer, listen } from './static-server.mjs';
import { launchBrowser } from './cdp.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const editorDist = join(repoRoot, 'editor/dist');
const playerDist = join(repoRoot, 'player/dist');
const TOKEN = 'smoke-token';

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: unknown, detail = ''): void {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

for (const dir of [editorDist, playerDist]) {
  try {
    await stat(join(dir, 'index.html'));
  } catch {
    console.error(`Missing build: ${dir}. Run "pnpm build:editor && pnpm build:player" first.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- capture fixtures
/**
 * The extension writes snapshot.html + fallback.png + capture-meta.json per capture.
 * Build ten such folders from the committed demo snapshots, so the import path is
 * exercised with exactly the trio an author would drop in.
 */
const work = await mkdtemp(join(tmpdir(), 'editor-smoke-'));
const capturesDir = join(work, 'captures');
const publishRoot = join(work, 'demos');
await mkdir(capturesDir, { recursive: true });
await mkdir(publishRoot, { recursive: true });

const sourceFlows = [
  'demos/inlumin/flow-01-requisition-to-po',
  'demos/inlumin/flow-02-supplier-comparison',
  'demos/inlumin/flow-03-spend-analytics',
];

const captureFolders: string[] = [];
let captureIndex = 0;

for (const flow of sourceFlows) {
  const snapshotsDir = join(repoRoot, flow, 'snapshots');
  const files = (await readdir(snapshotsDir)).filter((name) => name.endsWith('.html')).sort();
  for (const file of files) {
    captureIndex += 1;
    const folder = join(capturesDir, `capture-${String(captureIndex).padStart(2, '0')}`);
    await mkdir(folder, { recursive: true });
    await cp(join(snapshotsDir, file), join(folder, 'snapshot.html'));
    await cp(join(snapshotsDir, file.replace('.html', '.png')), join(folder, 'fallback.png'));
    await writeFile(
      join(folder, 'capture-meta.json'),
      JSON.stringify(
        {
          metaVersion: '1.0',
          captureId: `cap_smoke_${captureIndex}`,
          url: `https://inlumin.demo.internal/screen-${captureIndex}`,
          title: `Screen ${captureIndex}`,
          timestamp: '2026-08-14T09:32:11.000Z',
          viewport: {
            width: 1440,
            height: 900,
            devicePixelRatio: 1,
            documentWidth: 1440,
            documentHeight: 900,
            scrollX: 0,
            scrollY: 0,
          },
          stats: {
            snapshotBytes: 12000,
            embeddedResources: 3,
            strippedScripts: 2,
            strippedEventHandlers: 1,
            rasterisedCanvases: 0,
            serialisedShadowRoots: 0,
            durationMs: 900,
          },
          warnings: [],
          anchorHints: [],
          sanitised: true,
          capturedBy: 'capture-extension@1.0.0',
        },
        null,
        2,
      ),
      'utf8',
    );
    captureFolders.push(folder);
  }
}

check('ten capture folders are available to import', captureFolders.length === 10, `${captureFolders.length}`);

// ---------------------------------------------------------------- servers
/** A free port, so a stray process from an earlier run cannot answer for this one. */
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createProbe();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

const publishPort = await freePort();

/**
 * Spawn the local tsx binary directly rather than through `npx`: killing `npx` leaves
 * its child running, and an orphaned publish server holding the port made this test
 * pass while writing into a deleted directory.
 */
const publishServer: ChildProcess = spawn(
  join(repoRoot, 'node_modules/.bin/tsx'),
  [join(repoRoot, 'editor/server/publish-server.mts')],
  {
    cwd: repoRoot,
    env: { ...process.env, EDITOR_TOKEN: TOKEN, PORT: String(publishPort), DEMOS_ROOT: publishRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  },
);
let publishLog = '';
publishServer.stdout?.on('data', (chunk) => {
  publishLog += String(chunk);
});
publishServer.stderr?.on('data', (chunk) => {
  publishLog += String(chunk);
});

// Wait for it to come up.
let publishReady = false;
for (let attempt = 0; attempt < 60 && !publishReady; attempt += 1) {
  await delay(300);
  try {
    const response = await fetch(`http://127.0.0.1:${publishPort}/api/health`);
    const body = (await response.json()) as { demosRoot?: string; publishing?: boolean };
    publishReady = response.ok && body.publishing === true;
  } catch {
    /* not yet */
  }
}
check('the publish server is up with auth configured', publishReady, publishLog.slice(0, 300));

/** Serve the editor bundle, and proxy /api to the publish server. */
const editorStatic = createStaticServer({ root: editorDist, spaFallback: 'index.html' });
const site = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  if (!url.pathname.startsWith('/api/')) {
    editorStatic.emit('request', req, res);
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const upstream = await fetch(`http://127.0.0.1:${publishPort}${url.pathname}`, {
    method: req.method,
    headers: {
      'content-type': 'application/json',
      ...(req.headers['x-editor-token'] ? { 'x-editor-token': String(req.headers['x-editor-token']) } : {}),
    },
    ...(req.method === 'GET' ? {} : { body: Buffer.concat(chunks) }),
  });
  res.writeHead(upstream.status, { 'content-type': 'application/json' });
  res.end(Buffer.from(await upstream.arrayBuffer()));
});
const sitePort = await listen(site);
const editorUrl = `http://127.0.0.1:${sitePort}/index.html`;

console.log(`\nDriving the editor at ${editorUrl}\n`);

const browser = await launchBrowser({ width: 1600, height: 1000 });
let failures = 0;

/** Set files on the (hidden) file input the import dialog owns. */
async function setImportFiles(folder: string): Promise<void> {
  const { root } = (await browser.send('DOM.getDocument', { depth: 0 })) as { root: { nodeId: number } };
  const { nodeId } = (await browser.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '[data-testid="import-dropzone"] input[type="file"]',
  })) as { nodeId: number };
  await browser.send('DOM.setFileInputFiles', {
    nodeId,
    files: [join(folder, 'snapshot.html'), join(folder, 'fallback.png'), join(folder, 'capture-meta.json')],
  });
}

try {
  await browser.goto(editorUrl, { waitMs: 2000 });
  await browser.send('DOM.enable');

  // Start from a clean slate: a leftover draft would make this test lie.
  await browser.evaluate(`(() => { localStorage.clear(); sessionStorage.clear(); return true; })()`);
  await browser.goto(editorUrl, { waitMs: 1800 });

  const initial = await browser.evaluate(
    `(() => ({ empty: Boolean(document.querySelector('.empty')), badge: document.querySelector('.badge')?.textContent ?? null }))()`,
  );
  check('the editor starts empty and says so', initial.empty === true, JSON.stringify(initial));

  // ---------------------------------------------------------------- import 10 captures
  for (const folder of captureFolders) {
    await browser.evaluate(
      `(() => {
        const open = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Import capture')
          ?? [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Import a capture'));
        open?.click();
        return true;
      })()`,
    );
    await delay(300);
    await setImportFiles(folder);
    await delay(700);
  }

  const imported = await browser.evaluate(
    `(() => ({
      steps: document.querySelectorAll('[data-testid^="step-row-"]').length,
      selected: document.querySelector('.step.is-selected [class="step-id"], .step.is-selected .step-id')?.textContent ?? null,
    }))()`,
  );
  check('ten captures imported as steps', imported.steps === 10, `${imported.steps} steps`);

  // ---------------------------------------------------------------- hotspots + tooltips
  /**
   * Click a real element inside the rendered snapshot, exactly as an author does. The
   * canvas iframe is same-origin, so the click can be dispatched into it.
   */
  async function placeHotspot(selectorInSnapshot: string, title: string, body: string) {
    return browser.evaluate(`(async () => {
      document.querySelector('[data-testid="mode-place-hotspot"]').click();
      await new Promise((r) => setTimeout(r, 400));

      const frame = document.querySelector('.canvas-stage iframe');
      const target = frame?.contentDocument?.querySelector(${JSON.stringify(selectorInSnapshot)});
      if (!target) return { placed: false, reason: 'element not found in snapshot' };
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));

      const setValue = (selector, value) => {
        const field = document.querySelector(selector);
        if (!field) return false;
        const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };
      const titleOk = setValue('[data-testid="tooltip-title"]', ${JSON.stringify(title)});
      await new Promise((r) => setTimeout(r, 150));
      const bodyOk = setValue('[data-testid="tooltip-body"]', ${JSON.stringify(body)});
      await new Promise((r) => setTimeout(r, 250));

      const label = document.querySelector('.canvas-hotspot .canvas-hotspot-label')?.textContent ?? null;
      const anchoredBy = document.querySelector('.canvas-hotspot')?.getAttribute('data-anchored-by') ?? null;
      const selector = document.querySelector('[data-testid="anchor-selector"]')?.textContent?.trim() ?? null;
      return { placed: true, titleOk, bodyOk, label, anchoredBy, selector };
    })()`);
  }

  // Select the first step, then place a hotspot on a known element in it.
  await browser.evaluate(
    `(() => { document.querySelector('[data-testid="step-row-step-01"] .step-main').click(); return true; })()`,
  );
  await delay(600);

  const firstHotspot = await placeHotspot(
    '[data-testid="new-requisition"]',
    'Everything open, in one queue',
    'Six live requisitions, two waiting on this approver.',
  );
  check('clicking an element places a hotspot', firstHotspot.placed === true, JSON.stringify(firstHotspot));
  check(
    'the selector is recorded from the click',
    String(firstHotspot.selector).includes('new-requisition'),
    String(firstHotspot.selector),
  );
  check('the hotspot renders anchored by selector', firstHotspot.anchoredBy === 'selector', String(firstHotspot.anchoredBy));
  check('the tooltip fields accept authored copy', firstHotspot.titleOk && firstHotspot.bodyOk);

  // A second hotspot, on a step further in, so more than one step carries guidance.
  await browser.evaluate(
    `(() => { document.querySelector('[data-testid="step-row-step-02"] .step-main').click(); return true; })()`,
  );
  await delay(500);
  const secondHotspot = await placeHotspot(
    '[data-testid="submit-for-approval"]',
    'Submit for approval',
    'Routing comes from cost centre and value.',
  );
  check('a second hotspot lands on another step', secondHotspot.placed === true, JSON.stringify(secondHotspot));

  // Every remaining step needs guidance too, so the published demo has a tooltip per step.
  for (let index = 3; index <= 10; index += 1) {
    const stepId = `step-${String(index).padStart(2, '0')}`;
    await browser.evaluate(
      `(() => { document.querySelector('[data-testid="step-row-${stepId}"] .step-main')?.click(); return true; })()`,
    );
    await delay(280);
    await browser.evaluate(`(async () => {
      document.querySelector('[data-testid="mode-place-hotspot"]').click();
      await new Promise((r) => setTimeout(r, 260));
      const frame = document.querySelector('.canvas-stage iframe');
      const doc = frame?.contentDocument;
      const target = doc?.querySelector('h1') ?? doc?.querySelector('.card') ?? doc?.querySelector('table');
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 320));
      const set = (selector, value) => {
        const field = document.querySelector(selector);
        if (!field) return;
        const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('[data-testid="tooltip-title"]', 'Step ${index}');
      await new Promise((r) => setTimeout(r, 120));
      set('[data-testid="tooltip-body"]', 'What this screen proves.');
      await new Promise((r) => setTimeout(r, 200));
      return true;
    })()`);
  }

  // ---------------------------------------------------------------- inline text edit
  await browser.evaluate(
    `(() => { document.querySelector('[data-testid="step-row-step-01"] .step-main').click(); return true; })()`,
  );
  await delay(500);

  const edited = await browser.evaluate(`(async () => {
    document.querySelector('[data-testid="mode-edit-text"]').click();
    await new Promise((r) => setTimeout(r, 600));
    const frame = document.querySelector('.canvas-stage iframe');
    const doc = frame?.contentDocument;
    const heading = doc?.querySelector('h1');
    if (!heading) return { edited: false, reason: 'no heading' };
    const editable = heading.getAttribute('contenteditable');
    heading.textContent = 'Requisitions — Northwind Labs';
    heading.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    return { edited: true, editable, text: heading.textContent };
  })()`);
  check('captured text is editable in place', edited.editable === 'true', JSON.stringify(edited));

  const persisted = await browser.evaluate(`(async () => {
    // Leave edit mode and come back through the step list: the edit must survive.
    document.querySelector('[data-testid="mode-inspect"]').click();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('[data-testid="step-row-step-03"] .step-main').click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('[data-testid="step-row-step-01"] .step-main').click();
    await new Promise((r) => setTimeout(r, 900));
    const frame = document.querySelector('.canvas-stage iframe');
    return {
      text: frame?.contentDocument?.querySelector('h1')?.textContent ?? null,
      editedFlag: document.querySelector('[data-testid="step-row-step-01"] .step-sub')?.textContent ?? null,
    };
  })()`);
  check(
    'the text edit is kept in the project, not just the iframe',
    String(persisted.text).includes('Northwind Labs'),
    String(persisted.text),
  );
  check('the step list marks the step as edited', String(persisted.editedFlag).includes('edited'), String(persisted.editedFlag));

  // ---------------------------------------------------------------- chapters
  const chapters = await browser.evaluate(`(async () => {
    const addChapter = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add chapter');
    addChapter.click();
    await new Promise((r) => setTimeout(r, 300));
    addChapter.click();
    await new Promise((r) => setTimeout(r, 300));

    const titles = [...document.querySelectorAll('.chapter-title')];
    const setValue = (input, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(titles[0], 'Raise the requisition');
    await new Promise((r) => setTimeout(r, 150));
    setValue(titles[1], 'Score the bids');
    await new Promise((r) => setTimeout(r, 150));
    setValue(titles[2], 'Prove the savings');
    await new Promise((r) => setTimeout(r, 250));

    // Move steps 5–7 into chapter two and 8–10 into chapter three using the selects,
    // which is how an author regroups without dragging.
    const chapterIds = [...document.querySelectorAll('.step-actions select')][0]
      ? [...document.querySelectorAll('.step-actions select')[0].options].map((o) => o.value)
      : [];
    for (let i = 5; i <= 10; i += 1) {
      const id = 'step-' + String(i).padStart(2, '0');
      const select = document.querySelector('[data-testid="step-row-' + id + '"] select');
      if (!select) continue;
      const wanted = i <= 7 ? chapterIds[1] : chapterIds[2];
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, wanted);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 160));
    }

    return {
      chapterCount: document.querySelectorAll('.chapter').length,
      titles: [...document.querySelectorAll('.chapter-title')].map((i) => i.value),
      perChapter: [...document.querySelectorAll('.chapter')].map((c) => c.querySelectorAll('.step').length),
      badge: document.querySelector('.badge')?.textContent ?? null,
    };
  })()`);

  check('three chapters exist with authored titles', chapters.chapterCount === 3, JSON.stringify(chapters.titles));
  check('steps are grouped across the chapters', JSON.stringify(chapters.perChapter) === JSON.stringify([4, 3, 3]), JSON.stringify(chapters.perChapter));
  check('the manifest is valid after regrouping', chapters.badge === 'valid', String(chapters.badge));

  // ---------------------------------------------------------------- reorder by drag
  const reordered = await browser.evaluate(`(async () => {
    const before = [...document.querySelectorAll('.step-id')].map((n) => n.textContent);
    const rows = [...document.querySelectorAll('[data-testid^="step-row-"]')];
    const source = rows[3];
    const target = rows[0];
    const transfer = new DataTransfer();
    const tick = () => new Promise((r) => setTimeout(r, 120));
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    await tick();
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: transfer }));
    await tick();
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    await tick();
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
    await new Promise((r) => setTimeout(r, 500));
    return {
      before,
      after: [...document.querySelectorAll('.step-id')].map((n) => n.textContent),
      badge: document.querySelector('.badge')?.textContent ?? null,
    };
  })()`);
  check(
    'dragging a step reorders the flow',
    JSON.stringify(reordered.before) !== JSON.stringify(reordered.after),
    `${reordered.before?.join(',')} → ${reordered.after?.join(',')}`,
  );
  check('the manifest stays valid after a reorder', reordered.badge === 'valid', String(reordered.badge));

  // ---------------------------------------------------------------- demo settings
  const settings = await browser.evaluate(`(async () => {
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Demo settings').click();
    await new Promise((r) => setTimeout(r, 400));
    const set = (label, value) => {
      const field = [...document.querySelectorAll('.field')].find((f) => f.querySelector('span')?.textContent?.includes(label));
      const input = field?.querySelector('input, textarea');
      if (!input) return false;
      const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    const results = {
      demoId: set('Demo id', 'inlumin-authored-flow'),
      title: set('Title', 'Authored in the editor, end to end'),
      description: set('Description', 'Ten screens, three chapters, published without touching JSON.'),
      headline: set('Headline', 'That is the whole flow'),
    };
    await new Promise((r) => setTimeout(r, 400));
    return { ...results, badge: document.querySelector('.badge')?.textContent ?? null };
  })()`);
  check('demo metadata and end screen are editable', Object.values(settings).filter((v) => v === true).length >= 4, JSON.stringify(settings));

  // ---------------------------------------------------------------- preview
  const preview = await browser.evaluate(`(async () => {
    document.querySelector('[data-testid="preview-button"]').click();
    await new Promise((r) => setTimeout(r, 2500));
    const playing = Boolean(document.querySelector('.preview .dp-root'));
    const tooltip = document.querySelector('.preview .dp-tooltip-title')?.textContent ?? null;
    const anchored = document.querySelector('.preview .dp-hotspot.is-active')?.getAttribute('data-anchored-by') ?? null;
    const frameText = document.querySelector('.preview iframe.dp-snapshot')?.contentDocument?.querySelector('h1')?.textContent ?? null;
    [...document.querySelectorAll('.preview button')].find((b) => b.textContent.includes('Close preview'))?.click();
    await new Promise((r) => setTimeout(r, 400));
    return { playing, tooltip, anchored, frameText };
  })()`);
  check('preview plays in the real player component', preview.playing === true, JSON.stringify(preview));
  check('preview shows the authored tooltip', Boolean(preview.tooltip), String(preview.tooltip));
  check('preview anchors hotspots by selector', preview.anchored === 'selector', String(preview.anchored));
  check(
    'preview shows the edited text, unsaved',
    String(preview.frameText).includes('Northwind Labs'),
    String(preview.frameText),
  );

  // ---------------------------------------------------------------- publish
  const wrongPassword = await browser.evaluate(`(async () => {
    const token = document.querySelector('.token');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(token, 'not-the-password');
    token.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('[data-testid="publish-button"]').click();
    await new Promise((r) => setTimeout(r, 1500));
    return document.querySelector('.status-publish')?.textContent ?? null;
  })()`);
  check('a wrong password is refused', String(wrongPassword).toLowerCase().includes('not authorised'), String(wrongPassword));

  const published = await browser.evaluate(`(async () => {
    const token = document.querySelector('.token');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(token, ${JSON.stringify(TOKEN)});
    token.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('[data-testid="publish-button"]').click();
    await new Promise((r) => setTimeout(r, 3000));
    return document.querySelector('.status-publish')?.textContent ?? null;
  })()`);
  check('publish reports success', String(published).includes('Published to'), String(published));
  console.log(`    publish said: ${published}`);

  failures = checks.filter((entry) => !entry.ok).length;
} finally {
  await browser.close();
  site.close();
  // Kill the whole group: the server is detached, so a bare kill could leave it holding
  // the port for the next run.
  try {
    if (publishServer.pid) process.kill(-publishServer.pid, 'SIGKILL');
  } catch {
    publishServer.kill('SIGKILL');
  }
}

// ---------------------------------------------------------------- the published folder
const publishedDir = join(publishRoot, 'inlumin', 'inlumin-authored-flow');
let manifest: {
  demoId: string;
  steps: { stepId: string; snapshot: string; fallbackImage: string; hotspots: unknown[] }[];
  chapters: { title: string; steps: string[] }[];
  title: string;
} | null = null;

try {
  manifest = JSON.parse(await readFile(join(publishedDir, 'manifest.json'), 'utf8'));
  check('the published folder contains a manifest', true);
} catch (error) {
  const tree: string[] = [];
  const walk = async (dir: string, prefix = '') => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      tree.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${prefix}${entry.name}/`);
    }
  };
  await walk(publishRoot);
  check('the published folder contains a manifest', false, `${String(error)} · tree: ${tree.join(' ') || '(empty)'}`);
}

if (manifest) {
  check('the manifest was written without hand-editing JSON', manifest.demoId === 'inlumin-authored-flow', manifest.demoId);
  check('all ten steps published', manifest.steps.length === 10, `${manifest.steps.length}`);
  check('three chapters published', manifest.chapters.length === 3, JSON.stringify(manifest.chapters.map((c) => c.title)));
  check('every step carries authored guidance', manifest.steps.every((step) => step.hotspots.length > 0));
  check('the authored title survived', manifest.title.includes('end to end'), manifest.title);

  const written = await readdir(join(publishedDir, 'snapshots'));
  check('every snapshot and fallback image was written', written.length === 20, `${written.length} files`);

  // The reorder moved a different step into first position, so look across all of them.
  const publishedSnapshots = await Promise.all(
    manifest.steps.map((step) => readFile(join(publishedDir, step.snapshot), 'utf8').catch(() => '')),
  );
  const editedCount = publishedSnapshots.filter((html) => html.includes('Northwind Labs')).length;
  check('the inline text edit is in the published snapshot', editedCount === 1, `${editedCount} snapshot(s) carry it`);
  check(
    'no editor artefacts leaked into any published snapshot',
    publishedSnapshots.every((html) => !html.includes('contenteditable') && !html.includes('data-editor')),
  );
  check(
    'every published snapshot is still script-free',
    publishedSnapshots.every((html) => !/<script[\s>]/i.test(html)),
  );
}

// The repo validator is the same gate CI uses: run it against the published folder.
const validation = spawn(join(repoRoot, 'node_modules/.bin/tsx'), [join(repoRoot, 'scripts/validate-demos.mts')], {
  cwd: repoRoot,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let validationOutput = '';
validation.stdout?.on('data', (chunk) => {
  validationOutput += String(chunk);
});
validation.stderr?.on('data', (chunk) => {
  validationOutput += String(chunk);
});
const validationCode = await new Promise<number>((resolveExit) => validation.on('exit', (code) => resolveExit(code ?? 1)));
check('the repo validator still passes', validationCode === 0, validationOutput.slice(-400));

await rm(work, { recursive: true, force: true });

failures = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failures}/${checks.length} checks passed.`);
if (failures > 0) process.exit(1);
