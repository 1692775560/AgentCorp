/**
 * vite.config.web.ts
 * 纯 Web 预览用的 Vite 配置（不含 electron 插件）。
 * 用于在浏览器 / sandbox 预览渲染层，避免在无头环境里连带启动 Electron。
 * 与主 vite.config.ts 共用同样的 alias。生产打包仍走 vite.config.ts + electron-builder。
 */
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { llmProxyPlugin } from './vite-plugin-llm-proxy';

export default defineConfig(({ mode }) => {
  // 把 .env 里的 LLM_* 注入 process.env，供 dev 中间件（Node 侧）读取。
  // 这些不加 VITE_ 前缀，因此不会暴露给前端包。
  const env = loadEnv(mode, process.cwd(), '');
  for (const key of ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL']) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }
  return {
    base: './',
    plugins: [react(), llmProxyPlugin()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@electron': resolve(__dirname, 'electron'),
      },
    },
    server: {
      allowedHosts: ['.e2b.app'],
      host: '0.0.0.0',
      port: 3000,
    },
    optimizeDeps: {
      entries: ['index.html'],
    },
  };
});
