#!/usr/bin/env node
/**
 * Build the gated web target and copy in the demos it should serve.
 *
 *   node builds/web/scripts/build-web.mjs                 # all demos
 *   node builds/web/scripts/build-web.mjs --demo inlumin-flow-01 --demo inlumin-flow-02
 *
 * The output is a static directory plus the API routes in `builds/web/api/`, which the
 * host deploys as a serverless function (SPEC §8.1).
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '../../..');
const webRoot = join(repoRoot, 'builds/web');
const outDir = join(webRoot, 'dist');

const wanted = new Set();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--demo' && process.argv[i + 1]) wanted.add(process.argv[i + 1]);
}

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
        /* not a demo */
      }
    }
  }
  return found;
}

console.log('Building the gated web target…');
await execFileAsync('npx', ['vite', 'build'], { cwd: webRoot, env: process.env });

const demos = (await findDemos()).filter(({ manifest }) => wanted.size === 0 || wanted.has(manifest.demoId));
if (demos.length === 0) {
  throw new Error(`No demos matched ${[...wanted].join(', ') || '(all)'}`);
}

for (const demo of demos) {
  const target = join(outDir, demo.relative);
  await mkdir(target, { recursive: true });
  await cp(demo.dir, target, { recursive: true });
  console.log(`  + ${demo.manifest.demoId} → ${demo.relative}`);
}

// An index so a demo page can list what is available without hard-coded paths.
await writeFile(
  join(outDir, 'demos/index.json'),
  `${JSON.stringify(
    {
      generatedFor: 'web',
      demos: demos.map(({ manifest, relative }) => ({
        demoId: manifest.demoId,
        product: manifest.product,
        title: manifest.title,
        description: manifest.description,
        gated: manifest.settings?.gated ?? false,
        path: `/${relative}`,
      })),
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const { size } = await stat(join(outDir, 'index.html')).catch(() => ({ size: 0 }));
if (!size) throw new Error('vite build produced no index.html');

console.log(`\nWeb target built to ${outDir.replace(`${repoRoot}/`, '')} with ${demos.length} demo(s).`);
console.log('Deploy the directory as static assets and builds/web/api as the API route.');
