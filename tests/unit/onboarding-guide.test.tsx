// @vitest-environment jsdom
/**
 * tests/unit/onboarding-guide.test.tsx
 *
 * 新手引导（FirstRunGuide）分页向导的 DOM 测试：
 *   - 可见性规则：setupComplete 且（未看过 || 手动打开）时渲染；
 *   - 分页：下一步/上一步切换步骤标题；
 *   - 关闭（X / Esc）→ markOnboardingSeen + closeGuide；
 *   - 步骤 CTA → 关闭并跳转对应路由。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const refs = vi.hoisted(() => ({
  navigate: vi.fn(),
  settingsState: {
    setupComplete: true,
    onboardingSeen: false,
    guideOpen: false,
    markOnboardingSeen: vi.fn(),
    closeGuide: vi.fn(),
  },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => refs.navigate,
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (s: typeof refs.settingsState) => unknown) =>
    selector(refs.settingsState),
}));

import { FirstRunGuide } from '@/components/onboarding/FirstRunGuide';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  refs.settingsState.setupComplete = true;
  refs.settingsState.onboardingSeen = false;
  refs.settingsState.guideOpen = false;
  refs.navigate.mockClear();
  refs.settingsState.markOnboardingSeen.mockClear();
  refs.settingsState.closeGuide.mockClear();
});

afterEach(() => cleanup());

describe('FirstRunGuide · 新手引导分页向导', () => {
  it('setupComplete=false 时不渲染', () => {
    refs.settingsState.setupComplete = false;
    const { container } = render(<FirstRunGuide />);
    expect(container.firstChild).toBeNull();
  });

  it('首次启动（未看过）自动渲染第 1 步', () => {
    const { getByText } = render(<FirstRunGuide />);
    expect(getByText('五步上手 AgentCorp')).toBeInTheDocument();
    expect(getByText(/人才市场 · 雇一位 Agent 员工/)).toBeInTheDocument();
  });

  it('已看过且未手动打开时不渲染', () => {
    refs.settingsState.onboardingSeen = true;
    const { container } = render(<FirstRunGuide />);
    expect(container.firstChild).toBeNull();
  });

  it('已看过但 guideOpen=true（侧边栏手动打开）时渲染', () => {
    refs.settingsState.onboardingSeen = true;
    refs.settingsState.guideOpen = true;
    const { getByText } = render(<FirstRunGuide />);
    expect(getByText('五步上手 AgentCorp')).toBeInTheDocument();
  });

  it('下一步/上一步切换步骤', () => {
    const { getByText, queryByText } = render(<FirstRunGuide />);
    fireEvent.click(getByText('下一步'));
    expect(getByText(/HR 面试 · 让大模型考他/)).toBeInTheDocument();
    fireEvent.click(getByText('上一步'));
    expect(getByText(/人才市场 · 雇一位 Agent 员工/)).toBeInTheDocument();
    expect(queryByText(/HR 面试/)).not.toBeInTheDocument();
  });

  it('点 X 关闭 → 标记已看 + 关闭弹窗', () => {
    const { getByLabelText } = render(<FirstRunGuide />);
    fireEvent.click(getByLabelText('关闭引导'));
    expect(refs.settingsState.markOnboardingSeen).toHaveBeenCalledTimes(1);
    expect(refs.settingsState.closeGuide).toHaveBeenCalledTimes(1);
  });

  it('Esc 关闭 → 标记已看 + 关闭弹窗', () => {
    render(<FirstRunGuide />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(refs.settingsState.markOnboardingSeen).toHaveBeenCalledTimes(1);
    expect(refs.settingsState.closeGuide).toHaveBeenCalledTimes(1);
  });

  it('步骤 CTA → 关闭并跳转对应路由', () => {
    const { getByText } = render(<FirstRunGuide />);
    fireEvent.click(getByText(/去人才市场/));
    expect(refs.navigate).toHaveBeenCalledWith('/marketplace');
    expect(refs.settingsState.closeGuide).toHaveBeenCalledTimes(1);
  });

  it('最后一步显示「开始使用」', () => {
    const { getByText, getAllByLabelText } = render(<FirstRunGuide />);
    fireEvent.click(getAllByLabelText(/^第 5 步/)[0]);
    expect(getByText(/验收交付 · 文件落盘/)).toBeInTheDocument();
    fireEvent.click(getByText('开始使用'));
    expect(refs.settingsState.closeGuide).toHaveBeenCalledTimes(1);
  });
});
