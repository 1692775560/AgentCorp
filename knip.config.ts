import type { KnipConfig } from 'knip';

// Minimal knip config: entries are the Vite HTML entry, the renderer entry,
// and the Electron main/preload entries. scripts/qa holds standalone Node
// QA scripts that are intentionally outside the app module graph.
const config: KnipConfig = {
  entry: [
    'index.html',
    'src/main.tsx',
    'electron/main/index.ts',
    'electron/preload/index.ts',
  ],
  project: [
    'src/**/*.{ts,tsx}',
    'electron/**/*.ts',
    'shared/**/*.ts',
    'tests/**/*.{ts,tsx}',
  ],
  ignore: ['scripts/qa/**'],
};

export default config;
