import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Dedicated Vitest config — do NOT reuse the root vite.config.ts here:
// that one loads vite-plugin-electron, whose build hooks are not suitable
// for a test run.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@electron': resolve(__dirname, 'electron'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts?(x)'],
    // scripts/qa/*.test.ts are plain Node assertion scripts (no describe/it);
    // they must not be picked up by Vitest.
    exclude: ['scripts/qa/**', 'node_modules/**'],
  },
});
