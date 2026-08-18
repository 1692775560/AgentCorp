// @vitest-environment jsdom
/**
 * tests/unit/sidebar-scroll.test.tsx
 *
 * 回归测试：侧栏 <aside> 的 overflow 修复（新拟物投影被硬切成竖线）DOM 兜底验证。
 *
 * 历史：会话区「加号右侧竖线割裂感」修复 = globals.css .session-scroll 隐藏滚动条
 *   + Sidebar 根 <aside> 移除 overflow-hidden 改加 relative z-30。
 * 变更：会话列表已迁至独立「会话」页（/chats），Sidebar 不再内嵌会话区，
 *   原 session-scroll 容器随之移除；本测试保留 aside 层叠/溢出断言（竖线不复发），
 *   并断言 session-scroll 容器已不存在（防旧会话区被意外加回）。
 *
 * 运行：env -u NODE_OPTIONS npx vitest run tests/unit/sidebar-scroll.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// 用可控引用驱动各 store，避免加载真实 electron / IPC 依赖链。
const refs = vi.hoisted(() => ({
  chatState: {
    sessions: [] as unknown[],
    currentSessionKey: null,
    sessionLastActivity: {} as Record<string, number>,
    messages: [] as unknown[],
    switchSession: vi.fn(),
    newSession: vi.fn(),
    deleteSession: vi.fn(),
    loadSessions: vi.fn(),
    loadHistory: vi.fn(),
  },
  settingsState: { sidebarCollapsed: false, setSidebarCollapsed: vi.fn() },
  gatewayState: { status: { state: 'stopped' } },
  agentsState: { agents: [] as unknown[], fetchAgents: vi.fn() },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'zh' },
  }),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (s: typeof refs.settingsState) => unknown) =>
    selector(refs.settingsState),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (s: typeof refs.gatewayState) => unknown) =>
    selector(refs.gatewayState),
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: (selector: (s: typeof refs.agentsState) => unknown) =>
    selector(refs.agentsState),
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: Object.assign(
    (selector: (s: typeof refs.chatState) => unknown) => selector(refs.chatState),
    { getState: () => refs.chatState },
  ),
}));

import { Sidebar } from '@/components/layout/Sidebar';

// 满足 React 18+ act 环境警告。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  refs.settingsState.sidebarCollapsed = false;
  refs.gatewayState.status = { state: 'stopped' };
});

afterEach(() => {
  cleanup();
});

describe('Sidebar · 溢出/层级修复 DOM 兜底', () => {
  it('根 <aside> 不含 overflow-hidden（竖线元凶已移除）且含 relative z-30（提升层级）', () => {
    const { container } = render(<Sidebar />);
    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    expect(aside!.className).not.toContain('overflow-hidden');
    expect(aside!.className).toContain('relative z-30');
  });

  it('会话列表已迁至 /chats：侧栏不再有 session-scroll 容器', () => {
    const { container } = render(<Sidebar />);
    expect(container.querySelector('.session-scroll')).toBeNull();
  });

  it('折叠态下 <aside> 同样不含 overflow-hidden（修复不依赖展开态）', () => {
    refs.settingsState.sidebarCollapsed = true;
    const { container } = render(<Sidebar />);
    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    expect(aside!.className).not.toContain('overflow-hidden');
    expect(aside!.className).toContain('relative z-30');
  });
});
