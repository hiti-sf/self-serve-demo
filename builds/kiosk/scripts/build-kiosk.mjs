#!/usr/bin/env node
/**
 * Package a kiosk bundle (SPEC §8.2).
 *
 *   pnpm build:kiosk --demo inlumin-flow-01
 *   pnpm build:kiosk --all
 *   pnpm build:kiosk --all --all-platforms      # launcher binaries for Windows/macOS/Linux
 *
 * Produces a directory that runs with the wifi switched off, from a USB stick, by
 * double-clicking one file. The build **fails** if any external URL survives into the
 * output — that check is not advisory, it is the guarantee.
 */
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildLauncher } from '../launcher/build-launcher.mjs';
import { lintBundle, readAllowedHosts } from './lint-external-urls.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '../../..');
const kioskRoot = join(repoRoot, 'builds/kiosk');
const outDir = join(kioskRoot, 'dist-kiosk');

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const wanted = new Set();
let all = false;
let allPlatforms = false;
let eventsEndpoint = process.env.KIOSK_EVENTS_ENDPOINT ?? '';
let kioskLabel = process.env.KIOSK_LABEL ?? '';
let idleResetMs = Number(process.env.KIOSK_IDLE_RESET_MS ?? 120_000);

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--demo' && argv[i + 1]) wanted.add(argv[(i += 1)]);
  else if (arg === '--all') all = true;
  else if (arg === '--all-platforms') allPlatforms = true;
  else if (arg === '--events-endpoint' && argv[i + 1]) eventsEndpoint = argv[(i += 1)];
  else if (arg === '--label' && argv[i + 1]) kioskLabel = argv[(i += 1)];
  else if (arg === '--idle-reset-ms' && argv[i + 1]) idleResetMs = Number(argv[(i += 1)]);
  else if (arg === '--help') {
    console.log(
      'Usage: build-kiosk.mjs (--all | --demo <demoId> [--demo <demoId>…])\n' +
        '  --all-platforms         build launcher binaries for Windows, macOS and Linux\n' +
        '  --events-endpoint <url> where a sync flushes queued events\n' +
        '  --label <text>          identifies this booth machine on the picker\n' +
        '  --idle-reset-ms <ms>    attract-loop idle timeout (0 disables)',
    );
    process.exit(0);
  }
}

if (!all && wanted.size === 0) {
  console.error('Nothing to package. Pass --all, or --demo <demoId> one or more times.');
  process.exit(1);
}

// ---------------------------------------------------------------- demos
async function findDemos() {
  const demosRoot = join(repoRoot, 'demos');
  const found = [];
  for (const product of await readdir(demosRoot, { withFileTypes: true })) {
    if (!product.isDirectory() || product.name.startsWith('_')) continue;
    for (const flow of await readdir(join(demosRoot, product.name), { withFileTypes: true })) {
      if (!flow.isDirectory()) continue;
      const dir = join(demosRoot, product.name, flow.name);
      try {
        const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
        found.push({ dir, manifest, relative: join('demos', product.name, flow.name) });
      } catch {
        /* not a demo folder */
      }
    }
  }
  return found;
}

const available = await findDemos();
const demos = all ? available : available.filter(({ manifest }) => wanted.has(manifest.demoId));

if (demos.length === 0) {
  console.error(`No demos matched. Available: ${available.map((d) => d.manifest.demoId).join(', ') || '(none)'}`);
  process.exit(1);
}

const missing = [...wanted].filter((id) => !demos.some(({ manifest }) => manifest.demoId === id));
if (missing.length > 0) {
  console.error(`Unknown demoId(s): ${missing.join(', ')}`);
  process.exit(1);
}

// A build id makes a bundle on a stick traceable back to a build.
const buildId = `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;

// ---------------------------------------------------------------- build
console.log(`Packaging ${demos.length} demo(s) for kiosk…\n`);
await rm(outDir, { recursive: true, force: true });

await execFileAsync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
  cwd: kioskRoot,
  env: process.env,
});

for (const demo of demos) {
  const target = join(outDir, demo.relative);
  await mkdir(target, { recursive: true });
  await cp(demo.dir, target, { recursive: true });
  console.log(`  + ${demo.manifest.demoId} (${demo.manifest.steps.length} steps)`);
}

await writeFile(
  join(outDir, 'demos/index.json'),
  `${JSON.stringify(
    {
      generatedFor: 'kiosk',
      buildId,
      demos: demos.map(({ manifest, relative }) => ({
        demoId: manifest.demoId,
        product: manifest.product,
        title: manifest.title,
        description: manifest.description ?? '',
        // Relative, because the bundle is served from wherever the stick is mounted.
        path: `./${relative.split('\\').join('/')}`,
      })),
    },
    null,
    2,
  )}\n`,
  'utf8',
);

// Runtime config: the one place in the bundle allowed to name an external URL, and it
// is only used when an operator presses Sync (or the machine comes back online).
await writeFile(
  join(outDir, 'kiosk-config.json'),
  `${JSON.stringify(
    { eventsEndpoint, idleResetMs, autoSyncOnline: true, kioskLabel, buildId },
    null,
    2,
  )}\n`,
  'utf8',
);

// ---------------------------------------------------------------- launcher
const launcherBinaries = await buildLauncher({ all: allPlatforms });
for (const binary of launcherBinaries) {
  await cp(binary.path, join(outDir, binary.out));
  if (!binary.out.endsWith('.exe')) await chmod(join(outDir, binary.out), 0o755);
}

for (const file of ['launch.cmd', 'launch.command', 'launch.sh', 'serve.mjs']) {
  await cp(join(kioskRoot, 'launcher', file), join(outDir, file));
  if (file !== 'launch.cmd') await chmod(join(outDir, file), 0o755);
}

await writeFile(
  join(outDir, 'READ-ME-FIRST.txt'),
  [
    'Pivot Path interactive demos — offline bundle',
    '=============================================',
    '',
    `Build ${buildId}`,
    `Demos: ${demos.map(({ manifest }) => manifest.demoId).join(', ')}`,
    '',
    'To run the demos',
    '----------------',
    '  Windows   double-click  launch.cmd',
    '  macOS     double-click  launch.command',
    '  Linux     run           ./launch.sh',
    '',
    'A small window opens and your browser shows the demo picker. Leave that window',
    'open while you present; closing it stops the demo.',
    '',
    'No network is needed. Everything — screens, images, fonts — is inside this folder.',
    'Copy the whole folder to a USB stick and it works the same way.',
    '',
    'If macOS blocks the launcher, right-click launch.command and choose Open, or run',
    '  xattr -d com.apple.quarantine ./demo-kiosk-macos-*',
    '',
    'Analytics',
    '---------',
    'Everything visitors do is stored on this machine. To send it in, connect to a',
    'network, click the small square in the bottom-right of the demo picker, then',
    'press "Sync now". Nothing is lost if the sync fails — try again later.',
    '',
    eventsEndpoint
      ? `Sync endpoint: ${eventsEndpoint}`
      : 'No sync endpoint was configured for this bundle: events stay on this machine.',
    '',
  ].join('\n'),
  'utf8',
);

// ---------------------------------------------------------------- the guarantee
console.log('\nChecking the bundle for external references…');
const allowedHosts = await readAllowedHosts();
const { failures, informational, scanned } = await lintBundle(outDir, { allowedHosts });

console.log(`  scanned ${scanned} text file(s)`);
for (const note of informational) {
  console.log(`  · ${note.rel}: ${note.label} -> ${note.url}`);
}

if (failures.length > 0) {
  console.error(`\nBUILD FAILED — ${failures.length} external reference(s) in the bundle:\n`);
  const seen = new Set();
  for (const failure of failures) {
    const key = `${failure.rel}|${failure.url}|${failure.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.error(`  ${failure.rel}\n    ${failure.label}: ${failure.url}\n    ${failure.why}`);
  }
  console.error('\nA kiosk bundle must run with the wifi switched off. Not shipping this one.');
  // Leave the output in place so the offending file can be inspected.
  process.exit(1);
}

const { size: indexSize } = await stat(join(outDir, 'index.html'));
if (!indexSize) {
  console.error('BUILD FAILED — the bundle has no index.html');
  process.exit(1);
}

async function directorySize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await directorySize(path) : (await stat(path)).size;
  }
  return total;
}

const total = await directorySize(outDir);
console.log(`\nKiosk bundle ready: ${outDir.replace(`${repoRoot}/`, '')} (${Math.round(total / 1024 / 1024)} MB)`);
console.log(`  build ${buildId} · ${demos.length} demo(s) · ${launcherBinaries.length} launcher binary/binaries`);
console.log('  no external references — this bundle runs with the wifi switched off');
console.log('\nCopy the folder to a USB stick and double-click launch.cmd (Windows) or launch.command (macOS).');
