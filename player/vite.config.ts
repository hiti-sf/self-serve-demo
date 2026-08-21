import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error -- plain-JS dev tooling, no types needed
import { serveDemos } from '../scripts/vite-serve-demos.mjs';

/**
 * The player builds to a fully self-contained bundle: no CDN loads, no remote fonts,
 * nothing that phones home (SPEC §6, §11). Assets are inlined up to 4 kB and emitted
 * locally beyond that; the kiosk build lint enforces the guarantee on the output.
 */
export default defineConfig({
  plugins: [react(), serveDemos({ demosDir: fileURLToPath(new URL('../demos', import.meta.url)) })],
  base: './',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 4096,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // Predictable names so the kiosk packager can reason about the bundle.
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: { port: 5173 },
});
