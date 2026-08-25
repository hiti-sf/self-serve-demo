#!/usr/bin/env node
/**
 * Chrome MV3 build.
 *
 * Two Vite passes are required because MV3 treats the contexts differently:
 *   - content scripts cannot be ES modules, so they are bundled as a single IIFE
 *   - the service worker, offscreen document and popup are ES modules
 * @crxjs is deliberately avoided: it adds a dev-server dependency to a build whose
 * whole point is producing artefacts with no external references.
 */
import { build } from 'vite';
import { cp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

const shared = {
  root,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
};

await rm(outDir, { recursive: true, force: true });

// Pass 1 — content script as a self-contained IIFE.
await build({
  ...shared,
  build: {
    outDir,
    emptyOutDir: false,
    target: 'chrome116',
    minify: false,
    sourcemap: true,
    lib: {
      entry: resolve(root, 'src/content/capture.ts'),
      formats: ['iife'],
      name: 'DemoCapture',
      fileName: () => 'content/capture.js',
    },
    watch: watch ? {} : null,
  },
});

// Pass 2 — module contexts.
await build({
  ...shared,
  build: {
    outDir,
    emptyOutDir: false,
    target: 'chrome116',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        'background/service-worker': resolve(root, 'src/background/service-worker.ts'),
        'offscreen/convert': resolve(root, 'src/offscreen/convert.ts'),
        'popup/popup': resolve(root, 'src/popup/popup.ts'),
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
    watch: watch ? {} : null,
  },
});

/**
 * Chrome refuses to inject a script file whose bytes contain a Unicode *noncharacter*
 * or a lone surrogate — `chrome.scripting.executeScript` fails with the misleading
 * "It isn't UTF-8 encoded", even though the file decodes cleanly. postcss (a transitive
 * dependency of rrweb-snapshot) ships a literal U+FFFE in a BOM comparison, which is
 * enough to make the content script unloadable in every context.
 *
 * Escaping those code points to \uXXXX is safe wherever they can legally appear —
 * string literals, template literals, regex literals — and meaningless in a comment.
 * Nothing else in the output changes.
 */
function escapeUnloadableCodePoints(source) {
  let escaped = 0;
  const out = source.replace(/[\uD800-\uDFFF\uFDD0-\uFDEF\uFFFE\uFFFF]/g, (char, index) => {
    const code = char.codePointAt(0);
    // A properly paired surrogate is ordinary text and must be left alone.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = source.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) return char;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      const previous = source.charCodeAt(index - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) return char;
    }
    escaped += 1;
    return `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
  });
  return { out, escaped };
}

const emitted = await readdir(outDir, { recursive: true });
for (const name of emitted) {
  if (!name.endsWith('.js')) continue;
  const file = resolve(outDir, name);
  const { out, escaped } = escapeUnloadableCodePoints(await readFile(file, 'utf8'));
  if (escaped === 0) continue;
  await writeFile(file, out, 'utf8');
  console.log(`  escaped ${escaped} unloadable code point(s) in ${name}`);
}

// Static assets.
await mkdir(resolve(outDir, 'popup'), { recursive: true });
await mkdir(resolve(outDir, 'offscreen'), { recursive: true });
await cp(resolve(root, 'manifest.json'), resolve(outDir, 'manifest.json'));
await cp(resolve(root, 'src/popup/popup.html'), resolve(outDir, 'popup/popup.html'));
await cp(resolve(root, 'src/popup/popup.css'), resolve(outDir, 'popup/popup.css'));
await cp(resolve(root, 'src/offscreen/offscreen.html'), resolve(outDir, 'offscreen/offscreen.html'));
await cp(resolve(root, 'icons'), resolve(outDir, 'icons'), { recursive: true });

// The extension must not load anything at runtime that is not in the package.
const manifest = JSON.parse(await readFile(resolve(outDir, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('manifest_version must be 3');
await writeFile(resolve(outDir, 'BUILD_INFO.txt'), `built ${new Date().toISOString()}\n`, 'utf8');

console.log(`\nExtension built to ${outDir}`);
console.log('Load it with chrome://extensions → Developer mode → Load unpacked.');
