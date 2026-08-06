// @vitest-environment jsdom
/**
 * tests/unit/sidebar-scroll.test.tsx
 *
 * 回归测试：会话区「加号右侧竖线割裂感」CSS 修复的 DOM 兜底验证。
 *
 * 修复点（工程师已落盘）：
 *   1) src/styles/globals.css .session-scroll —— 彻底隐藏会话区滚动条（含 WebKit
 *      track / thumb 与 scrollbar-gutter），消除 hover 时落在加号右侧的墨色细线。
 *      它是真正的滚动容器（overflow-y-auto + min-h-0 flex-1），吸收溢出。
 *   2) src/components/layout/Sidebar.tsx 的 <aside> —— 移除 overflow-hidden，改加
 *      relative z-30。竖线的真正根因是：上一轮加的 overflow-hidden 把侧栏右边缘按钮
 *      （折叠/搜索/会话加号，均带 shadow-sm，被 globals.css 重映射成向右下偏移 4px 的
 *       新拟物双阴影）的右下投影在侧栏右边界处硬切一刀，形成清晰竖线。移除 overflow-hidden
 *      后投影落在平涂 neu-surface 上自然淡化；relative z-30 把整个左侧任务栏提到最上层。
 *
 * 本测试在 jsdom 中渲染 <Sidebar />，断言：
 *   - 根 <aside> 的 className 不再含 overflow-hidden（竖线元凶已移除），且含 relative z-30；
 *   - 会话滚动容器带 session-scroll 类（即 globals.css 规则作用的正确目标元素）。
 *
 * 注意：纯 CSS 视觉（竖线是否真的消失）无法在单测里截图验证，需用户在
 * http://127.0.0.1:5174/ 预览中肉眼确认。本测试只锁住「class 已正确落到 DOM」。
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

vi.mock('@/lib/pinned-sessions', () => ({
  usePinnedSessions: () => ({
    pinnedSessionKeySet: new Set<string>(),
    toggleSessionPinned: vi.fn(),
  }),
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

describe('Sidebar · 会话区滚动条修复 DOM 兜底', () => {
  it('根 <aside> 不含 overflow-hidden（竖线元凶已移除）且含 relative z-30（提升层级）', () => {
    const { container } = render(<Sidebar />);
    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    expect(aside!.className).not.toContain('overflow-hidden');
    expect(aside!.className).toContain('relative z-30');
  });

  it('会话滚动容器带 session-scroll 类（globals.css 规则作用目标正确）', () => {
    const { container } = render(<Sidebar />);
    const scroll = container.querySelector('.session-scroll');
    expect(scroll).not.toBeNull();
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
