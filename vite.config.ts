import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import { resolve } from 'path';
import { llmProxyPlugin } from './vite-plugin-llm-proxy';

function isMainProcessExternal(id: string): boolean {
  if (!id || id.startsWith('\0')) return false;
  if (id.startsWith('.') || id.startsWith('/') || /^[A-Za-z]:[\\/]/.test(id)) return false;
  if (id.startsWith('@/') || id.startsWith('@electron/')) return false;
  return true;
}

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  // 把 .env 里的 LLM_* 注入 process.env，供 dev 中间件（Node 侧）读取。
  // 与 vite.config.web.ts 保持一致：Electron dev 的渲染进程同样只调同源
  // /api/llm/chat，缺了 llmProxyPlugin 会导致真实执行 404。
  const env = loadEnv(mode, process.cwd(), '');
  for (const key of ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL']) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }

  const mainProcessExternal =
    command === 'serve'
      ? isMainProcessExternal
      : ['electron', 'bufferutil', 'utf-8-validate'];

  return {
  // Required for Electron: all asset URLs must be relative because the renderer
  // loads via file:// in production. vite-plugin-electron-renderer sets this
  // automatically, but we declare it explicitly so the intent is clear and the
  // build remains correct even if plugin order ever changes.
  base: './',
  plugins: [
    react(),
    llmProxyPlugin(),
    electron([
      {
        // Main process entry file
        entry: 'electron/main/index.ts',
        onstart(options) {
          options.startup();
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              // Dev mode should externalize almost all non-local modules so Electron
              // main cold-start does not rebundle the whole runtime dependency graph.
              // Production builds keep the current bundling strategy so packaged
              // artifacts remain self-contained.
              external: mainProcessExternal,
            },
          },
        },
      },
      {
        // Preload scripts entry file
        entry: 'electron/preload/index.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@electron': resolve(__dirname, 'electron'),
    },
  },
  server: {
    allowedHosts: ['.e2b.app'],
    // Bind dev server to IPv4 localhost explicitly. The default "localhost"
    // can resolve to ::1 on Windows, leaving Electron's renderer fetching from
    // 127.0.0.1 unable to reach the server and causing a permanent "loading..."
    // state.
    host: '127.0.0.1',
    port: 5173,
  },
  optimizeDeps: {
    // Only scan the main entry HTML. The default scanner walks every *.html in
    // the project root, including the stale dist-web/index.html, whose bundled
    // chunks import deps (e.g. @emotion/is-prop-valid) that are not resolvable
    // from the project root and deadlock Vite's dependency scanner.
    entries: ['index.html'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      onwarn(warning, warn) {
        // Suppress expected dynamic import warnings for store circular dependency lazy-loading
        if (warning.message && warning.message.includes('dynamic import will not move module into another chunk')) {
          return;
        }
        warn(warning);
      },
    },
  },
  };
});
