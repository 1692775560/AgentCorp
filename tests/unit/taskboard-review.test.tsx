// @vitest-environment jsdom
/**
 * tests/unit/taskboard-review.test.tsx
 *
 * 看板「评审 → 完成」通路测试（修复前：任务永远停在评审列，无验收入口）：
 * - review 态任务详情显示「待你验收」+ 验收通过/驳回重做；
 * - 验收通过 → updateTask(id, { status: 'done' })；
 * - 驳回重做 → updateTask(id, { status: 'todo', workState: 'idle' })（回待办由 AutoWorker 重跑）；
 * - done 态不显示验收条；
 * - /kanban?task=<id> 自动选中对应任务（系统通知点击跳转的落点）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { KanbanTask } from '@/types/task';

const refs = vi.hoisted(() => ({
  navigate: vi.fn(),
  setSearchParams: vi.fn(),
  searchParams: new URLSearchParams(),
  updateTask: vi.fn(async () => ({})),
  openDirectAgentSession: vi.fn(() => 'session-key-1'),
  approvalsState: {
    tasks: [] as KanbanTask[],
    approvals: [] as unknown[],
    tasksLoading: false,
    tasksError: null,
    loading: false,
    error: null,
  },
  agentsState: {
    agents: [
      { id: 'leader-1', name: '小李', avatar: '🦊', teamRole: 'Tech Lead' },
      { id: 'member-1', name: '阿强', avatar: '🐻', teamRole: '前端' },
    ] as Array<{ id: string; name: string; avatar: string; teamRole: string }>,
  },
  teamsState: {
    teams: [
      { id: 'team-1', name: '前端组', leaderId: 'leader-1', memberIds: ['member-1'] },
    ],
  },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => refs.navigate,
  useSearchParams: () => [refs.searchParams, refs.setSearchParams],
}));

vi.mock('@/stores/approvals', () => ({
  useApprovalsStore: (selector: (s: unknown) => unknown) =>
    selector({
      ...refs.approvalsState,
      fetchTasks: vi.fn(async () => {}),
      fetchApprovals: vi.fn(async () => {}),
      approveItem: vi.fn(async () => {}),
      rejectItem: vi.fn(async () => {}),
      updateTask: refs.updateTask,
    }),
}));

vi.mock('@/stores/teams', () => ({
  useTeamsStore: (selector: (s: unknown) => unknown) =>
    selector({ teams: refs.teamsState.teams, fetchTeams: vi.fn(async () => {}) }),
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: (selector: (s: unknown) => unknown) =>
    selector({ agents: refs.agentsState.agents, fetchAgents: vi.fn(async () => {}) }),
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: {
    getState: () => ({ openDirectAgentSession: refs.openDirectAgentSession }),
  },
}));

vi.mock('@/pages/Office/AutoWorkerBar', () => ({
  AutoWorkerBar: () => null,
}));

vi.mock('@/pages/Chat/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(async () => ({ success: false })),
}));

import { TaskBoard } from '@/pages/Office/TaskBoard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeTask(over: Partial<KanbanTask>): KanbanTask {
  return {
    id: 't1',
    title: '做一个计算器',
    description: '网页版',
    status: 'review',
    workState: 'done',
    priority: 'medium',
    executionEvents: [],
    ...over,
  } as KanbanTask;
}

beforeEach(() => {
  refs.approvalsState.tasks = [];
  refs.searchParams = new URLSearchParams();
  refs.updateTask.mockClear();
  refs.setSearchParams.mockClear();
  refs.navigate.mockClear();
  refs.openDirectAgentSession.mockClear();
});

afterEach(() => cleanup());

describe('TaskBoard · 评审验收通路', () => {
  it('review 任务选中后显示「待你验收」与两个动作按钮', () => {
    refs.approvalsState.tasks = [makeTask({})];
    const { getByText } = render(<TaskBoard />);
    fireEvent.click(getByText('做一个计算器'));
    expect(getByText('待你验收')).toBeInTheDocument();
    expect(getByText('验收通过')).toBeInTheDocument();
    expect(getByText('驳回重做')).toBeInTheDocument();
  });

  it('验收通过 → updateTask(id, { status: done })', () => {
    refs.approvalsState.tasks = [makeTask({})];
    const { getByText } = render(<TaskBoard />);
    fireEvent.click(getByText('做一个计算器'));
    fireEvent.click(getByText('验收通过'));
    expect(refs.updateTask).toHaveBeenCalledWith('t1', { status: 'done' });
  });

  it('驳回重做 → updateTask(id, { status: todo, workState: idle })', () => {
    refs.approvalsState.tasks = [makeTask({})];
    const { getByText } = render(<TaskBoard />);
    fireEvent.click(getByText('做一个计算器'));
    fireEvent.click(getByText('驳回重做'));
    expect(refs.updateTask).toHaveBeenCalledWith('t1', { status: 'todo', workState: 'idle' });
  });

  it('done 任务不显示验收条', () => {
    refs.approvalsState.tasks = [makeTask({ status: 'done' })];
    const { getByText, queryByText } = render(<TaskBoard />);
    fireEvent.click(getByText('做一个计算器'));
    expect(queryByText('待你验收')).not.toBeInTheDocument();
  });

  it('?task=<id> 自动选中该任务并清掉参数（通知跳转落点）', () => {
    refs.approvalsState.tasks = [makeTask({})];
    refs.searchParams = new URLSearchParams('task=t1');
    const { getByText } = render(<TaskBoard />);
    // 未点卡片，详情已展开（验收条可见即证明已选中）
    expect(getByText('待你验收')).toBeInTheDocument();
    expect(refs.setSearchParams).toHaveBeenCalledWith({}, { replace: true });
  });
});

describe('TaskBoard · A2A 协作过程展示与私聊', () => {
  const a2aEvents = [
    { type: 'a2a:leader-1 → member-1', content: '【第1轮】拆解并分派子任务', createdAt: new Date().toISOString(), status: 'done' },
    { type: 'a2a:member-1 → leader-1', content: '【第1轮】交付，leader 判 PASS', createdAt: new Date().toISOString(), status: 'done' },
  ] as KanbanTask['executionEvents'];

  it('参与成员条显示真实姓名与 leader 徽标，并给出协作统计', () => {
    refs.approvalsState.tasks = [makeTask({ teamId: 'team-1', executionEvents: a2aEvents })];
    const { getByText } = render(<TaskBoard />);
    fireEvent.click(getByText('做一个计算器'));
    expect(getByText('参与成员')).toBeInTheDocument();
    expect(getByText('小李')).toBeInTheDocument();
    expect(getByText('阿强')).toBeInTheDocument();
    expect(getByText('leader')).toBeInTheDocument();
    expect(getByText(/共 1 轮协作 · 1 次通过/)).toBeInTheDocument();
  });

  it('点成员私聊按钮 → openDirectAgentSession + 跳回首页聊天', () => {
    refs.approvalsState.tasks = [makeTask({ teamId: 'team-1', executionEvents: a2aEvents })];
    const { getByText, getByTitle } = render(<TaskBoard />);
    fireEvent.click(getByText('做一个计算器'));
    fireEvent.click(getByTitle('私聊 阿强'));
    expect(refs.openDirectAgentSession).toHaveBeenCalledWith('member-1', {
      teamId: 'team-1',
      teamName: '前端组',
      isLeaderChat: false,
    });
    expect(refs.navigate).toHaveBeenCalledWith('/');
  });

  it('leader 私聊带 isLeaderChat: true', () => {
    refs.approvalsState.tasks = [makeTask({ teamId: 'team-1', executionEvents: a2aEvents })];
    const { getByText, getByTitle } = render(<TaskBoard />);
    fireEvent.click(getByText('做一个计算器'));
    fireEvent.click(getByTitle('私聊 小李'));
    expect(refs.openDirectAgentSession).toHaveBeenCalledWith('leader-1', {
      teamId: 'team-1',
      teamName: '前端组',
      isLeaderChat: true,
    });
  });
});
