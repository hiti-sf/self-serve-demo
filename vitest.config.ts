import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Component tests render real player components, so JSX has to compile here too.
  plugins: [react()],
  test: {
    include: [
      'packages/**/*.test.{ts,tsx}',
      'adapters/**/*.test.{ts,tsx}',
      'player/**/*.test.{ts,tsx}',
      'editor/**/*.test.{ts,tsx}',
      'capture-extension/**/*.test.{ts,tsx}',
      'builds/**/*.test.{ts,tsx}',
      'scripts/**/*.test.{ts,tsx}',
    ],
    // Per-file overrides via the `@vitest-environment` docblock.
    environment: 'node',
  },
});
