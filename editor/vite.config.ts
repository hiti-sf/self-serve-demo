import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Internal authoring app (SPEC §7). Not customer-facing, so it is free to depend on
 * things the player and kiosk bundle cannot (JSZip for the export download).
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
  server: {
    port: 5176,
    proxy: {
      // The publish server writes into demos/ and holds the auth check.
      '/api': 'http://127.0.0.1:8788',
    },
  },
});
