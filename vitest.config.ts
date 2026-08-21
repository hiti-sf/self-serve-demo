import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'adapters/**/*.test.ts',
      'player/**/*.test.ts',
      'capture-extension/**/*.test.ts',
      'builds/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    environment: 'node',
  },
});
