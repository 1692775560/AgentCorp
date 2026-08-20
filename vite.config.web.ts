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
      // 默认只监听本机回环：本 dev server 挂着无鉴权的 LLM 代理
      // （vite-plugin-llm-proxy 直接用 LLM_API_KEY 转发），绑 0.0.0.0 会让
      // 同网段任何人把本机 key 当免费代理。确需局域网演示时 WEB_HOST=0.0.0.0 显式放开。
      host: process.env.WEB_HOST ?? '127.0.0.1',
      port: 3000,
    },
    optimizeDeps: {
      entries: ['index.html'],
    },
  };
});
