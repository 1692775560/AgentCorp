/**
 * React Application Entry Point
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './i18n';
import './styles/globals.css';
import { initializeDefaultTransports } from './lib/api-client';
import { ensureBrowserPreviewElectronShim } from './lib/browser-preview';

// 无 Electron 宿主（浏览器 / sandbox web 预览）时，注入预览用的 electron shim。
// 它决定 isBrowserPreviewMode() 是否为真——进而决定人才市场 / Office / 任务看板
// 是否回退到本地种子 + preview-mock 数据。自守卫：真实 Electron 已有 window.electron
// 时直接跳过，对桌面端零副作用。必须在任何组件读取该状态之前执行。
try {
  ensureBrowserPreviewElectronShim();
} catch (error) {
  console.error('Failed to ensure browser preview shim:', error);
}

try {
  initializeDefaultTransports();
} catch (error) {
  console.error('Failed to initialize default transports:', error);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
