// @vitest-environment jsdom
/**
 * tests/unit/onboarding-guide.test.tsx
 *
 * 新手引导（FirstRunGuide）交互式清单的 DOM 测试：
 *   - 可见性规则：setupComplete 且（未看过 || 手动打开）时渲染；
 *   - 自动完成检测：按 store 快照打勾（进度文案 + 已完成样式）；
 *   - 「去做」→ 跳转对应路由并暂时收起（不记完成态）；
 *   - 跳过 → markOnboardingSeen + closeGuide；X / Esc 仅暂时关闭；
 *   - 全部完成 → 展示完成态，延迟后自动收起并记完成态。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, within } from '@testing-library/react';
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
  agentsState: { agents: [] as Array<{ id: string }> },
  teamsState: { teams: [] as Array<{ id: string }> },
  approvalsState: {
    tasks: [] as Array<{ isTeamTask: boolean; teamId?: string; status: string }>,
  },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => refs.navigate,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } & Record<string, unknown>) =>
      (opts?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(opts?.[name] ?? ''),
      ),
    i18n: { language: 'zh' },
  }),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (s: typeof refs.settingsState) => unknown) =>
    selector(refs.settingsState),
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: (selector: (s: typeof refs.agentsState) => unknown) =>
    selector(refs.agentsState),
}));

vi.mock('@/stores/teams', () => ({
  useTeamsStore: (selector: (s: typeof refs.teamsState) => unknown) =>
    selector(refs.teamsState),
}));

vi.mock('@/stores/approvals', () => ({
  useApprovalsStore: (selector: (s: typeof refs.approvalsState) => unknown) =>
    selector(refs.approvalsState),
}));

import { FirstRunGuide } from '@/components/onboarding/FirstRunGuide';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  refs.settingsState.setupComplete = true;
  refs.settingsState.onboardingSeen = false;
  refs.settingsState.guideOpen = false;
  refs.agentsState.agents = [];
  refs.teamsState.teams = [];
  refs.approvalsState.tasks = [];
  refs.navigate.mockClear();
  refs.settingsState.markOnboardingSeen.mockClear();
  refs.settingsState.closeGuide.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('FirstRunGuide · 新手引导交互式清单', () => {
  it('setupComplete=false 时不渲染', () => {
    refs.settingsState.setupComplete = false;
    const { container } = render(<FirstRunGuide />);
    expect(container.firstChild).toBeNull();
  });

  it('首次启动（未看过）自动渲染四步清单', () => {
    const { getByText } = render(<FirstRunGuide />);
    expect(getByText('四步上手 AgentCorp')).toBeInTheDocument();
    expect(getByText('认识你的员工')).toBeInTheDocument();
    expect(getByText('组建第一个团队')).toBeInTheDocument();
    expect(getByText('派第一个团队任务')).toBeInTheDocument();
    expect(getByText('验收第一份交付')).toBeInTheDocument();
    expect(getByText('已完成 0/4')).toBeInTheDocument();
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
    expect(getByText('四步上手 AgentCorp')).toBeInTheDocument();
  });

  it('自动完成检测：按 store 快照打勾并更新进度', () => {
    refs.agentsState.agents = [{ id: 'a1' }];
    refs.teamsState.teams = [{ id: 't1' }];
    const { getByText, getByLabelText } = render(<FirstRunGuide />);
    expect(getByText('已完成 2/4')).toBeInTheDocument();
    // 已完成的步骤行带完成态样式（黄底）
    const doneRow = getByLabelText(/第 1 步：认识你的员工/);
    expect(doneRow.className).toContain('bg-[#FFD233]/10');
    const pendingRow = getByLabelText(/第 3 步：派第一个团队任务/);
    expect(pendingRow.className).not.toContain('bg-[#FFD233]/10');
  });

  it('派任务/验收按团队任务状态打勾', () => {
    refs.approvalsState.tasks = [
      { isTeamTask: true, teamId: 't1', status: 'in-progress' },
    ];
    const { getByText } = render(<FirstRunGuide />);
    expect(getByText('已完成 1/4')).toBeInTheDocument();
  });

  it('「去做」→ 跳转对应路由并暂时收起（不记完成态）', () => {
    const { getByLabelText } = render(<FirstRunGuide />);
    const teamRow = getByLabelText(/第 2 步/);
    fireEvent.click(within(teamRow).getByText(/去组建团队/));
    expect(refs.navigate).toHaveBeenCalledWith('/team-builder');
    expect(refs.settingsState.closeGuide).toHaveBeenCalledTimes(1);
    expect(refs.settingsState.markOnboardingSeen).not.toHaveBeenCalled();
  });

  it('「跳过引导」→ 标记已看 + 关闭弹窗', () => {
    const { getByText } = render(<FirstRunGuide />);
    fireEvent.click(getByText('跳过引导'));
    expect(refs.settingsState.markOnboardingSeen).toHaveBeenCalledTimes(1);
    expect(refs.settingsState.closeGuide).toHaveBeenCalledTimes(1);
  });

  it('点 X 仅暂时关闭，不记完成态', () => {
    const { getByLabelText } = render(<FirstRunGuide />);
    fireEvent.click(getByLabelText('关闭引导'));
    expect(refs.settingsState.closeGuide).toHaveBeenCalledTimes(1);
    expect(refs.settingsState.markOnboardingSeen).not.toHaveBeenCalled();
  });

  it('Esc 仅暂时关闭，不记完成态', () => {
    render(<FirstRunGuide />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(refs.settingsState.closeGuide).toHaveBeenCalledTimes(1);
    expect(refs.settingsState.markOnboardingSeen).not.toHaveBeenCalled();
  });

  it('全部完成 → 展示完成态，延迟后自动收起并记完成态', () => {
    vi.useFakeTimers();
    refs.agentsState.agents = [{ id: 'a1' }];
    refs.teamsState.teams = [{ id: 't1' }];
    refs.approvalsState.tasks = [{ isTeamTask: true, teamId: 't1', status: 'done' }];
    const { getByText } = render(<FirstRunGuide />);
    expect(getByText('全部完成，开张大吉')).toBeInTheDocument();
    expect(refs.settingsState.markOnboardingSeen).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(refs.settingsState.markOnboardingSeen).toHaveBeenCalledTimes(1);
    expect(refs.settingsState.closeGuide).toHaveBeenCalledTimes(1);
  });

  it('完成态点「开始使用」立即收起并记完成态', () => {
    refs.agentsState.agents = [{ id: 'a1' }];
    refs.teamsState.teams = [{ id: 't1' }];
    refs.approvalsState.tasks = [{ isTeamTask: true, teamId: 't1', status: 'done' }];
    const { getByText } = render(<FirstRunGuide />);
    fireEvent.click(getByText('开始使用'));
    expect(refs.settingsState.markOnboardingSeen).toHaveBeenCalledTimes(1);
    expect(refs.settingsState.closeGuide).toHaveBeenCalledTimes(1);
  });
});
