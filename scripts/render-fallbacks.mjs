#!/usr/bin/env node
/**
 * Render each step's snapshot to its `fallbackImage` PNG.
 *
 * Every step needs a mandatory fallback image (SPEC §4). The capture extension emits one
 * per capture; this script regenerates them for snapshots that were hand-authored or
 * text-edited in the editor, and doubles as a check that a snapshot really does render
 * with **zero network access** — headless Chromium runs here with networking disabled.
 *
 *   node scripts/render-fallbacks.mjs                 # every demo
 *   node scripts/render-fallbacks.mjs demos/inlumin/flow-01-requisition-to-po
 */
import { execFile } from 'node:child_process';
import { readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

async function findChromium() {
  for (const candidate of CHROMIUM_CANDIDATES) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  // Playwright installs under a versioned directory; find whatever is there.
  try {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
    for (const entry of await readdir(base)) {
      if (!entry.startsWith('chromium-')) continue;
      const candidate = join(base, entry, 'chrome-linux', 'chrome');
      await stat(candidate);
      return candidate;
    }
  } catch {
    /* fall through */
  }
  throw new Error(
    'No Chromium found. Set CHROMIUM_PATH to a Chrome/Chromium binary and run again.',
  );
}

async function findDemoDirs(target) {
  if (target) return [resolve(repoRoot, target)];
  const demosRoot = join(repoRoot, 'demos');
  const dirs = [];
  for (const product of await readdir(demosRoot, { withFileTypes: true })) {
    if (!product.isDirectory()) continue;
    for (const flow of await readdir(join(demosRoot, product.name), { withFileTypes: true })) {
      if (!flow.isDirectory()) continue;
      try {
        await stat(join(demosRoot, product.name, flow.name, 'manifest.json'));
        dirs.push(join(demosRoot, product.name, flow.name));
      } catch {
        /* not a demo folder */
      }
    }
  }
  return dirs;
}

async function renderStep(chromium, demoDir, step) {
  const snapshotPath = join(demoDir, step.snapshot);
  const outPath = join(demoDir, step.fallbackImage);
  const { width, height } = step.viewport ?? { width: 1440, height: 900 };

  // --dump-dom/--screenshot writes to the cwd as screenshot.png in some builds, so
  // render into the target directory and rename deterministically.
  const tempName = `.render-${basename(outPath)}`;
  await execFileAsync(
    chromium,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      // The snapshot must render with no network at all. If it needs the network, the
      // render is wrong and we want to see that here, not on a wifi-disabled laptop.
      '--disable-features=NetworkService,NetworkServiceInProcess',
      '--host-resolver-rules=MAP * ~NOTFOUND',
      `--window-size=${width},${height}`,
      `--screenshot=${join(dirname(outPath), tempName)}`,
      `file://${snapshotPath}`,
    ],
    { timeout: 60_000, cwd: dirname(outPath) },
  ).catch((error) => {
    // Chromium exits non-zero on some benign warnings but still writes the file.
    if (!error?.stderr?.includes('Written to file')) throw error;
  });

  await rename(join(dirname(outPath), tempName), outPath);
  const { size } = await stat(outPath);
  return { outPath, size };
}

const [, , target] = process.argv;
const chromium = await findChromium();
console.log(`Using ${chromium}`);

let rendered = 0;
for (const demoDir of await findDemoDirs(target)) {
  const manifest = JSON.parse(await readFile(join(demoDir, 'manifest.json'), 'utf8'));
  console.log(`\n${manifest.demoId}`);
  for (const step of manifest.steps) {
    try {
      const { outPath, size } = await renderStep(chromium, demoDir, step);
      console.log(`  ${step.stepId} → ${outPath.replace(`${repoRoot}/`, '')} (${Math.round(size / 1024)} kB)`);
      rendered += 1;
    } catch (error) {
      console.error(`  ${step.stepId} FAILED: ${error.message}`);
      await rm(join(demoDir, `.render-${basename(step.fallbackImage)}`), { force: true });
      process.exitCode = 1;
    }
  }
}

console.log(`\n${rendered} fallback image(s) rendered.`);
