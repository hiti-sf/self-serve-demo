#!/usr/bin/env node
/**
 * End-to-end smoke test for the player (SPEC §12, M2 acceptance).
 *
 * Serves the built player and the demos folder over HTTP, drives a real headless
 * Chromium through a whole flow, and asserts what the acceptance gate asks for:
 * snapshots render, hotspots anchor to their selectors, resize re-anchors them, the
 * chapter menu and keyboard navigation work, and a deliberately broken snapshot falls
 * back to its image instead of breaking the demo.
 *
 *   pnpm build:player && node scripts/smoke-player.mjs [demoId]
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStaticServer, listen } from './static-server.mjs';
import { launchBrowser } from './cdp.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
// Tolerate a trailing slash so `for d in demos/*/; do …` works as written.
const demoDirArg = (process.argv[2] ?? 'demos/inlumin/flow-01-requisition-to-po').replace(/\/+$/, '');
const shotsDir = join(repoRoot, '.smoke');

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  console.log(`  ${condition ? '✓' : '✗'} ${name}${detail && !condition ? ` — ${detail}` : ''}`);
}

/**
 * Serve from a throwaway copy so we can break one snapshot without touching the repo.
 */
async function stageSite() {
  const stage = await mkdtemp(join(tmpdir(), 'demo-smoke-site-'));
  await cp(join(repoRoot, 'player/dist'), join(stage, 'player'), { recursive: true });
  await cp(join(repoRoot, 'demos'), join(stage, 'demos'), { recursive: true });
  return stage;
}

const stage = await stageSite();
await mkdir(shotsDir, { recursive: true });

const manifest = JSON.parse(await readFile(join(stage, demoDirArg, 'manifest.json'), 'utf8'));
const server = createStaticServer({ root: stage });
const port = await listen(server);
const origin = `http://127.0.0.1:${port}`;
const demoUrl = `${origin}/player/index.html?demo=/${demoDirArg}`;

console.log(`\nSmoke-testing ${manifest.demoId} at ${demoUrl}\n`);

const browser = await launchBrowser({ width: 1440, height: 900 });
let failures = 0;

try {
  await browser.goto(demoUrl, { waitMs: 2500 });

  // --- step 1: the demo loaded and the first snapshot rendered -------------------
  const first = await browser.evaluate(`(() => {
    const root = document.querySelector('.dp-root');
    const frame = document.querySelector('iframe.dp-snapshot');
    const innerDoc = frame && frame.contentDocument;
    const hotspot = document.querySelector('.dp-hotspot.is-active');
    return {
      demoId: root && root.getAttribute('data-demo-id'),
      stepId: root && root.getAttribute('data-step-id'),
      hasFrame: Boolean(frame),
      innerNodes: innerDoc ? innerDoc.body.querySelectorAll('*').length : 0,
      innerScripts: innerDoc ? innerDoc.querySelectorAll('script').length : 0,
      hotspotAnchoredBy: hotspot && hotspot.getAttribute('data-anchored-by'),
      hotspotRect: hotspot ? hotspot.getBoundingClientRect().toJSON() : null,
      tooltipTitle: document.querySelector('.dp-tooltip-title')?.textContent ?? null,
      progress: document.querySelector('.dp-progress-count')?.textContent ?? null,
    };
  })()`);

  check('manifest loaded into the player', first.demoId === manifest.demoId, String(first.demoId));
  check('snapshot rendered in a sandboxed iframe', first.hasFrame && first.innerNodes > 40, `${first.innerNodes} nodes`);
  check('snapshot contains no scripts', first.innerScripts === 0, `${first.innerScripts} script tags`);
  check('first hotspot anchored by selector', first.hotspotAnchoredBy === 'selector', String(first.hotspotAnchoredBy));
  check('tooltip copy came from the manifest', first.tooltipTitle === manifest.steps[0].hotspots[0].tooltip.title, String(first.tooltipTitle));
  check('progress shows the whole demo', first.progress === `Step 1 of ${manifest.steps.length}`, String(first.progress));

  await browser.screenshot(join(shotsDir, `${manifest.demoId}-step-01.png`));

  // --- the hotspot sits on top of the element it anchors to -----------------------
  // The iframe is laid out at the captured size and scaled with a transform, so the
  // element's own rect is in captured pixels and has to be scaled before comparing.
  const overlap = await browser.evaluate(`(() => {
    const frame = document.querySelector('iframe.dp-snapshot');
    const selector = ${JSON.stringify(manifest.steps[0].hotspots[0].anchor.selector)};
    const target = frame.contentDocument.querySelector(selector);
    const hotspot = document.querySelector('.dp-hotspot.is-active');
    if (!target || !hotspot) return null;
    const a = target.getBoundingClientRect();
    const b = hotspot.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const scale = frameRect.width / frame.offsetWidth;
    return {
      scale,
      targetCentre: [
        frameRect.left + (a.left + a.width / 2) * scale,
        frameRect.top + (a.top + a.height / 2) * scale,
      ],
      hotspotCentre: [b.left + b.width / 2, b.top + b.height / 2],
    };
  })()`);
  const drift = overlap
    ? Math.hypot(overlap.targetCentre[0] - overlap.hotspotCentre[0], overlap.targetCentre[1] - overlap.hotspotCentre[1])
    : Number.POSITIVE_INFINITY;
  check(
    'hotspot sits on its element (<4px drift)',
    drift < 4,
    `${drift.toFixed(1)}px at scale ${overlap?.scale?.toFixed(3)}`,
  );

  // --- resize and confirm the hotspot re-anchors ---------------------------------
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.delay(900);
  const afterResize = await browser.evaluate(`(() => {
    const frame = document.querySelector('iframe.dp-snapshot');
    const selector = ${JSON.stringify(manifest.steps[0].hotspots[0].anchor.selector)};
    const target = frame.contentDocument.querySelector(selector);
    const hotspot = document.querySelector('.dp-hotspot.is-active');
    const frameRect = frame.getBoundingClientRect();
    const a = target.getBoundingClientRect();
    const b = hotspot.getBoundingClientRect();
    const scale = frameRect.width / frame.offsetWidth;
    return {
      drift: Math.hypot(
        (a.left + a.width / 2) * scale + frameRect.left - (b.left + b.width / 2),
        (a.top + a.height / 2) * scale + frameRect.top - (b.top + b.height / 2),
      ),
      anchoredBy: hotspot.getAttribute('data-anchored-by'),
    };
  })()`);
  check('hotspot re-anchors after a resize', afterResize.drift < 6 && afterResize.anchoredBy === 'selector', `${afterResize.drift.toFixed(1)}px`);
  await browser.screenshot(join(shotsDir, `${manifest.demoId}-resized.png`));
  await browser.send('Emulation.clearDeviceMetricsOverride');
  await browser.delay(600);

  // --- play the whole demo by clicking the active hotspot ------------------------
  const visited = [];
  for (let guard = 0; guard < 24; guard += 1) {
    const state = await browser.evaluate(`(() => {
      const root = document.querySelector('.dp-root');
      if (!root) return { finished: true };
      const hotspot = document.querySelector('.dp-hotspot.is-active');
      const next = document.querySelector('.dp-tooltip-actions .dp-button--primary');
      (hotspot ?? next)?.click();
      return { finished: false, stepId: root.getAttribute('data-step-id') };
    })()`);
    if (state.finished) break;
    visited.push(state.stepId);
    await browser.delay(500);
  }
  const endScreen = await browser.evaluate(
    `(() => ({
      headline: document.querySelector('.dp-end-headline')?.textContent ?? null,
      cta: document.querySelector('.dp-end-actions .dp-button--primary')?.textContent ?? null,
    }))()`,
  );
  check('demo plays through to the end screen', endScreen.headline === manifest.endScreen.headline, String(endScreen.headline));
  check('end screen shows the primary CTA', endScreen.cta === manifest.endScreen.cta.label, String(endScreen.cta));
  check(
    'every step was visited',
    new Set(visited).size >= manifest.steps.length,
    `visited ${new Set(visited).size} of ${manifest.steps.length}`,
  );
  await browser.screenshot(join(shotsDir, `${manifest.demoId}-end.png`));

  // --- chapter menu and keyboard navigation -------------------------------------
  await browser.goto(demoUrl, { waitMs: 2000 });
  // Within a step, hotspots are sequential guidance: the arrow key walks the hotspots
  // first and only then moves to the next step. Press until the step actually changes.
  const keyboard = await browser.evaluate(`(async () => {
    const fire = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    const stepNow = () => document.querySelector('.dp-root')?.getAttribute('data-step-id');
    const settle = () => new Promise((r) => setTimeout(r, 350));
    const first = stepNow();
    let second = first;
    let presses = 0;
    while (second === first && presses < 8) {
      fire('ArrowRight');
      presses += 1;
      await settle();
      second = stepNow();
    }
    let back = second;
    for (let i = 0; i < presses && back !== first; i += 1) {
      fire('ArrowLeft');
      await settle();
      back = stepNow();
    }
    fire('Escape');
    await settle();
    const menu = Boolean(document.querySelector('.dp-sheet'));
    return { first, second, back, menu, presses };
  })()`);
  check(
    'ArrowRight advances',
    keyboard.second && keyboard.second !== keyboard.first,
    `${keyboard.first} → ${keyboard.second} after ${keyboard.presses} press(es)`,
  );
  check('ArrowLeft goes back', keyboard.back === keyboard.first, String(keyboard.back));
  check('Escape opens the chapter menu', keyboard.menu === true);

  // --- deliberately break one snapshot and confirm the fallback path -------------
  const brokenStep = manifest.steps[1];
  await writeFile(join(stage, demoDirArg, brokenStep.snapshot), '', 'utf8');
  await browser.goto(`${demoUrl}#broken`, { waitMs: 1500 });
  const fallback = await browser.evaluate(`(async () => {
    const target = ${JSON.stringify(brokenStep.stepId)};
    const stepNow = () => document.querySelector('.dp-root')?.getAttribute('data-step-id');
    const advance = () =>
      document.querySelector('.dp-hotspot.is-active, .dp-tooltip-actions .dp-button--primary')?.click();
    for (let i = 0; i < 10 && stepNow() !== target; i += 1) {
      advance();
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 900));
    const stage = document.querySelector('[data-testid="snapshot-fallback"]');
    const hotspot = document.querySelector('.dp-hotspot.is-active');
    return {
      usedFallback: Boolean(stage),
      imageSrc: stage?.querySelector('img')?.getAttribute('src') ?? null,
      anchoredBy: hotspot?.getAttribute('data-anchored-by') ?? null,
      notice: document.querySelector('.dp-notice')?.textContent ?? null,
      stepId: stepNow() ?? null,
    };
  })()`);
  check('a broken snapshot falls back to its image', fallback.usedFallback === true, JSON.stringify(fallback));
  check(
    'fallback image is the manifest one',
    String(fallback.imageSrc).endsWith(brokenStep.fallbackImage),
    String(fallback.imageSrc),
  );
  check(
    'hotspots switch to coordinate anchoring',
    brokenStep.hotspots.length === 0 || fallback.anchoredBy === 'coordinates',
    String(fallback.anchoredBy),
  );
  check('the visitor is told it is a static image', Boolean(fallback.notice));
  await browser.screenshot(join(shotsDir, `${manifest.demoId}-fallback.png`));

  failures = checks.filter((entry) => !entry.ok).length;
} finally {
  await browser.close();
  server.close();
  await rm(stage, { recursive: true, force: true });
}

console.log(`\n${checks.length - failures}/${checks.length} checks passed. Screenshots in .smoke/`);
if (failures > 0) process.exit(1);
