import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import renderer from 'vite-plugin-electron-renderer';
import { resolve } from 'path';

// Web-only dev config: serves the React renderer in a plain browser WITHOUT the
// Electron *main process* plugin (which crashes in dev because the Electron
// binary is not installed / would need a GUI). We KEEP vite-plugin-electron-renderer
// because it externalizes `electron` + node builtins for the browser (the renderer
// imports @electron/utils/token-usage which uses node:fs).
//
// A browser-preview shim is injected into index.html at serve time so that
// window.electron is defined and IPC calls become safe no-ops (mirrors
// src/lib/browser-preview.ts createElectronShim), preventing white-screens.
export default defineConfig(() => {
  return {
    base: './',
    plugins: [
      react(),
      renderer(),
      {
        name: 'inject-browser-preview-shim',
        transformIndexHtml(html) {
          return {
            html,
            tags: [
              {
                tag: 'script',
                injectTo: 'head',
                children:
                  'window.electron = { ipcRenderer: { invoke: async () => undefined, on: () => () => undefined, once: () => undefined, off: () => undefined }, openExternal: async () => {}, platform: "web", isDev: true, __agentcorpBrowserPreviewShim: true };',
              },
            ],
          };
        },
      },
    ],
    // 仅扫描 src 进行依赖预打包，避免误扫 dist/（Electron 构建产物）里的 proxy chunk
    // 导致 "@emotion/is-prop-valid 无法解析" 的误报与预打包跳过。
    optimizeDeps: {
      entries: ['src/**/*.{ts,tsx}'],
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@electron': resolve(__dirname, 'electron'),
      },
    },
    server: {
      port: 5174,
      host: '0.0.0.0',
      // 放行 E2B 公开预览域名（Vite 会校验 Host 头，默认拒绝非 localhost）。
      // 用 .e2b.app 后缀通配，适配沙盒重开后子域变化。
      allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
    },
    build: {
      outDir: 'dist-web',
      emptyOutDir: true,
      rollupOptions: {
        // 主应用 + 闭环 Demo 双入口（验收：产物含 demo.html）
        input: {
          index: resolve(__dirname, 'index.html'),
          demo: resolve(__dirname, 'demo.html'),
        },
      },
    },
  };
});
