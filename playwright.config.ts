import { defineConfig } from '@playwright/test';

/**
 * Playwright 配置（GOAI Demo E2E · SP-15）
 * webServer 自动起 vite web 预览（5174），跑完自动关闭。
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5174',
  },
  webServer: {
    command: 'corepack pnpm web',
    url: 'http://localhost:5174/demo.html',
    reuseExistingServer: true,
    timeout: 60_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  },
});
