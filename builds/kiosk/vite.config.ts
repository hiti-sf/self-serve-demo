import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error -- plain-JS dev tooling, no types needed
import { serveDemos } from '../../scripts/vite-serve-demos.mjs';

/**
 * Kiosk target (SPEC §8.2): a self-contained bundle with zero network calls at runtime.
 *
 * `base: './'` matters — the bundle is served from whatever directory the launcher
 * happens to run in, on a USB stick with an unpredictable path.
 */
export default defineConfig({
  plugins: [react(), serveDemos({ demosDir: fileURLToPath(new URL('../../demos', import.meta.url)) })],
  base: './',
  build: {
    outDir: 'dist',
    // Inline aggressively: fewer files to copy to a USB stick, fewer ways to break it.
    assetsInlineLimit: 8192,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: { port: 5175 },
});
