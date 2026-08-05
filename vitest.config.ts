import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// 专用测试配置 —— 故意**不含** vite-plugin-electron / vite-electron-renderer。
//
// 原因：vite.config.ts 里的 renderer() 插件会把 node: 内置（node:fs/promises、
// node:path、node:os）别名重定向到渲染进程 shim（.vite-electron-renderer/*），
// 该 shim 内部用 `require()`，在 vitest 的 ESM 运行器下会抛
// "ReferenceError: require is not defined in ES module scope"，导致
// telemetryCollector 的 node: 动态 import 在单测里崩。
//
// 测试运行在 Node 进程内，本就该用原生 node: 模块，因此这里去掉 electron 插件，
// 同时保留 @ → src、@electron → electron 的别名与 react 插件（.tsx 测试需要）。
//
// 另：scripts/qa/*.qa.test.ts 是严过关的「独立 QA 验收套件」，设计用
// esbuild --bundle + node --experimental-strip-types 单独跑，不是 vitest 测试，
// 故从 vitest 的 include 范围里排除，避免 import 阶段崩。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@electron': resolve(__dirname, 'electron'),
    },
  },
  test: {
    // .tsx 测试用文件级 `// @vitest-environment jsdom` 覆盖；其余 .ts 走 node
    environment: 'node',
    pool: 'threads',
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-electron/**',
      '**/scripts/qa/**',
      '**/.git/**',
    ],
  },
});
