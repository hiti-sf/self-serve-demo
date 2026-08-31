import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error -- plain-JS dev tooling, no types needed
import { serveDemos } from '../../scripts/vite-serve-demos.mjs';

/**
 * Gated web target (SPEC §8.1). Same player, plus the lead gate and the HTTP analytics
 * transport. Nothing external is loaded: the events endpoint is same-origin.
 */
export default defineConfig({
  plugins: [react(), serveDemos({ demosDir: fileURLToPath(new URL('../../demos', import.meta.url)) })],
  base: './',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 4096,
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5174,
    proxy: {
      // The dev server (server/dev-server.mjs) holds the CRM adapter; credentials
      // never reach the browser bundle (§8.1, §11).
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
