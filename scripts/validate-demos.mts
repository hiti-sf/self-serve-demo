#!/usr/bin/env tsx
/**
 * Validate every demo folder in the repo.
 *
 * Demos are content, authored by non-engineers (SPEC §2, §7), so the guarantees that
 * matter have to be checked mechanically rather than by review:
 *   1. the manifest validates against the shared schema
 *   2. every referenced snapshot, fallback image and asset exists
 *   3. no snapshot contains a script, an inline handler or a javascript: URL
 *   4. no snapshot reaches the network at render time
 *   5. no snapshot contains anything that looks like personal data
 *   6. every hotspot selector actually resolves in its snapshot
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { resolveSelector, safeParseManifest, scanText, type Manifest } from '../packages/shared/src/index.js';
import { assertScriptFree } from '../capture-extension/src/lib/sanitise.js';
import { findExternalUrlsInHtml } from '../capture-extension/src/lib/urls.js';

const repoRoot = resolve(import.meta.dirname, '..');

interface Problem {
  demo: string;
  where: string;
  message: string;
}

const problems: Problem[] = [];
let checkedSnapshots = 0;
let checkedHotspots = 0;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function demoFolders(): Promise<string[]> {
  const demosRoot = join(repoRoot, 'demos');
  const found: string[] = [];
  for (const product of await readdir(demosRoot, { withFileTypes: true })) {
    if (!product.isDirectory() || product.name.startsWith('_')) continue;
    for (const flow of await readdir(join(demosRoot, product.name), { withFileTypes: true })) {
      if (!flow.isDirectory()) continue;
      const folder = join(demosRoot, product.name, flow.name);
      if (await exists(join(folder, 'manifest.json'))) found.push(folder);
    }
  }
  return found;
}

async function validateDemo(folder: string): Promise<void> {
  const relative = folder.replace(`${repoRoot}/`, '');
  const raw = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')) as unknown;

  const parsed = safeParseManifest(raw);
  if (!parsed.ok) {
    for (const issue of parsed.issues) problems.push({ demo: relative, where: 'manifest.json', message: issue });
    return;
  }
  const manifest: Manifest = parsed.manifest;

  if (manifest.theme.logo && !(await exists(resolve(folder, manifest.theme.logo)))) {
    problems.push({ demo: relative, where: 'theme.logo', message: `missing asset ${manifest.theme.logo}` });
  }

  for (const step of manifest.steps) {
    const snapshotPath = resolve(folder, step.snapshot);
    const fallbackPath = resolve(folder, step.fallbackImage);

    if (!(await exists(fallbackPath))) {
      problems.push({
        demo: relative,
        where: step.stepId,
        message: `missing fallbackImage ${step.fallbackImage} — run "pnpm render:fallbacks"`,
      });
    }

    if (!(await exists(snapshotPath))) {
      problems.push({ demo: relative, where: step.stepId, message: `missing snapshot ${step.snapshot}` });
      continue;
    }

    const html = await readFile(snapshotPath, 'utf8');
    checkedSnapshots += 1;

    try {
      assertScriptFree(html);
    } catch (error) {
      problems.push({
        demo: relative,
        where: step.stepId,
        message: (error as Error).message,
      });
    }

    const external = findExternalUrlsInHtml(html);
    if (external.length > 0) {
      problems.push({
        demo: relative,
        where: step.stepId,
        message: `${external.length} external URL(s) would load at render time: ${external.slice(0, 3).join(', ')}`,
      });
    }

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Demo data must be synthetic (§11). Scan visible text only: attribute noise like a
    // base64 data URI is not what this check is for.
    const visibleText = doc.body?.textContent ?? '';
    for (const finding of scanText(visibleText)) {
      problems.push({
        demo: relative,
        where: step.stepId,
        message: `possible ${finding.label.toLowerCase()} in snapshot text: "${finding.match}"`,
      });
    }

    for (const hotspot of step.hotspots) {
      checkedHotspots += 1;
      if (!resolveSelector(doc, hotspot.anchor.selector)) {
        problems.push({
          demo: relative,
          where: `${step.stepId}/${hotspot.hotspotId}`,
          message: `selector does not resolve in the snapshot: ${hotspot.anchor.selector} (the player would fall back to coordinates)`,
        });
      }
    }

    dom.window.close();
  }

  console.log(
    `✓ ${manifest.demoId} — ${manifest.steps.length} steps, ${manifest.chapters.length} chapters, ` +
      `${manifest.steps.reduce((sum, step) => sum + step.hotspots.length, 0)} hotspots`,
  );
}

const folders = await demoFolders();
if (folders.length === 0) {
  console.error('No demo folders found under demos/.');
  process.exit(1);
}

for (const folder of folders) {
  try {
    await validateDemo(folder);
  } catch (error) {
    problems.push({
      demo: folder.replace(`${repoRoot}/`, ''),
      where: 'manifest.json',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(
  `\n${folders.length} demo(s), ${checkedSnapshots} snapshot(s), ${checkedHotspots} hotspot selector(s) checked.`,
);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n`);
  for (const problem of problems) {
    console.error(`  ${problem.demo} · ${problem.where}\n    ${problem.message}`);
  }
  process.exit(1);
}
console.log('All demos valid.');
