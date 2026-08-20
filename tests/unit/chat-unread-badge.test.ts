/**
 * tests/unit/chat-unread-badge.test.ts
 *
 * 未读角标累加回归：
 * 1) 非当前会话收到有实质内容的事件（final/error）→ unreadCount +1；
 *    started/delta 等过程噪音不计；同一 runId 的多条流式事件只计 1 次（按 run 去重）。
 * 2) switchSession 时 markSessionAsRead 清零。
 * 3) 本地专属会话（team:/team-task:）不走 handleChatEvent，
 *    未读在 appendTeamChatEvent / appendTaskExecutionEvent 侧记账；
 *    任务会话只把 chat: 前缀事件算作未读，a2a: trace 噪音不计。
 *
 * mock 模式参照 chat-history-stale.test.ts（useGatewayStore.setState({rpc})）
 * 与 teams-store.test.ts（vi.mock('@/lib/host-api') 内存实现）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamSummary, TeamsSnapshot } from '@/types/team';
import type { TasksSnapshot } from '@/types/task';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useTeamsStore } from '@/stores/teams';
import { useApprovalsStore } from '@/stores/approvals';

const SESSION_A = 'agent:main:unread-a';
const SESSION_B = 'agent:main:unread-b';
const TEAM_SESSION = 'team:t1';
const TASK_SESSION = 'team-task:task1';

function makeTeam(id: string): TeamSummary {
  return {
    id,
    name: `团队-${id}`,
    leaderId: 'leader-1',
    memberIds: ['m-1'],
    createdAt: 0,
    chatEvents: [],
    memberCount: 2,
    activeTaskCount: 0,
    lastActiveTime: undefined,
    leaderName: 'Leader',
    memberAvatars: [],
  };
}

let teams: TeamSummary[];

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    const appendMatch = path.match(/^\/api\/teams\/(.+)\/chat-events$/);
    if (appendMatch && init?.method === 'POST') {
      const teamId = decodeURIComponent(appendMatch[1]);
      const body = JSON.parse(String(init.body)) as { content?: string };
      teams = teams.map((t) =>
        t.id === teamId
          ? { ...t, chatEvents: [...(t.chatEvents ?? []), { ...body, createdAt: new Date().toISOString() } as never] }
          : t,
      );
      return { teams } satisfies TeamsSnapshot;
    }
    const taskEventMatch = path.match(/^\/api\/tasks\/(.+)\/execution\/events$/);
    if (taskEventMatch && init?.method === 'POST') {
      const task = { id: decodeURIComponent(taskEventMatch[1]) };
      return { task, tasks: [task] } as unknown as TasksSnapshot;
    }
    throw new Error(`unexpected path: ${path}`);
  }),
}));

const rpcMock = vi.fn<(method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>>();

function resetStores(currentSessionKey: string = SESSION_A) {
  useChatStore.setState({
    sessions: [
      { key: SESSION_A, displayName: SESSION_A },
      { key: SESSION_B, displayName: SESSION_B },
      { key: TEAM_SESSION, displayName: TEAM_SESSION },
      { key: TASK_SESSION, displayName: TASK_SESSION },
    ],
    sessionUnreadCounts: {},
    sessionLabels: {},
    sessionLastActivity: {},
    messages: [],
    currentSessionKey,
    currentAgentId: 'main',
    sending: false,
    activeRunId: null,
    error: null,
    loading: false,
    streamingText: '',
    streamingMessage: null,
    pendingFinal: false,
    lastUserMessageAt: null,
  } as never);
  teams = [makeTeam('t1')];
  useTeamsStore.setState({ teams, loading: false, error: null });
  useApprovalsStore.setState({ tasks: [], tasksLoading: false, tasksError: null } as never);
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function unreadOf(key: string): number {
  const state = useChatStore.getState();
  return state.sessions.find((s) => s.key === key)?.unreadCount ?? 0;
}

function assistantFinal(runId: string, sessionKey: string, text: string) {
  return {
    runId,
    sessionKey,
    state: 'final',
    message: { role: 'assistant', content: text },
  };
}

describe('非当前会话未读角标累加', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ messages: [] });
    useGatewayStore.setState({ rpc: rpcMock } as never);
    resetStores();
  });

  it('非当前会话收到 final 事件 → 未读 +1，且同步到 sessions 列表', () => {
    useChatStore.getState().handleChatEvent(assistantFinal('run-b1', SESSION_B, '你好'));
    expect(useChatStore.getState().sessionUnreadCounts[SESSION_B]).toBe(1);
    expect(unreadOf(SESSION_B)).toBe(1);
  });

  it('同一 runId 的多条流式事件只计 1 条未读（按 run 去重）', () => {
    const handle = useChatStore.getState().handleChatEvent;
    handle({ runId: 'run-b2', sessionKey: SESSION_B, state: 'started' });
    handle({ runId: 'run-b2', sessionKey: SESSION_B, state: 'delta', message: { role: 'assistant', content: '中' } });
    // 工具结果 final 与正文 final 同属一个 run
    handle({ runId: 'run-b2', sessionKey: SESSION_B, state: 'final', message: { role: 'toolResult', content: 'tool' } });
    handle(assistantFinal('run-b2', SESSION_B, '中间过程'));
    handle(assistantFinal('run-b2', SESSION_B, '最终回复'));
    expect(useChatStore.getState().sessionUnreadCounts[SESSION_B]).toBe(1);
  });

  it('不同 run 各自计 1 条未读', () => {
    const handle = useChatStore.getState().handleChatEvent;
    handle(assistantFinal('run-b3', SESSION_B, '第一条'));
    handle(assistantFinal('run-b4', SESSION_B, '第二条'));
    expect(useChatStore.getState().sessionUnreadCounts[SESSION_B]).toBe(2);
    expect(unreadOf(SESSION_B)).toBe(2);
  });

  it('started/error 之外的过程噪音不计；error 计 1 条', () => {
    const handle = useChatStore.getState().handleChatEvent;
    handle({ runId: 'run-b5', sessionKey: SESSION_B, state: 'started' });
    expect(useChatStore.getState().sessionUnreadCounts[SESSION_B]).toBeUndefined();
    handle({ runId: 'run-b5', sessionKey: SESSION_B, state: 'error', errorMessage: 'boom' });
    expect(useChatStore.getState().sessionUnreadCounts[SESSION_B]).toBe(1);
  });

  it('无 state 但带 stopReason 的消息按 final 计未读', () => {
    useChatStore.getState().handleChatEvent({
      runId: 'run-b6',
      sessionKey: SESSION_B,
      message: { role: 'assistant', content: '完成', stopReason: 'end_turn' },
    });
    expect(useChatStore.getState().sessionUnreadCounts[SESSION_B]).toBe(1);
  });

  it('当前会话的事件不计未读', () => {
    useChatStore.getState().handleChatEvent(assistantFinal('run-a1', SESSION_A, '当前会话回复'));
    expect(useChatStore.getState().sessionUnreadCounts[SESSION_A]).toBeUndefined();
    expect(unreadOf(SESSION_A)).toBe(0);
  });

  it('switchSession 后该会话未读清零', async () => {
    useChatStore.getState().handleChatEvent(assistantFinal('run-b7', SESSION_B, '新消息'));
    expect(unreadOf(SESSION_B)).toBe(1);

    useChatStore.getState().switchSession(SESSION_B);
    await flush();
    expect(useChatStore.getState().sessionUnreadCounts[SESSION_B]).toBeUndefined();
    expect(unreadOf(SESSION_B)).toBe(0);
  });

  it('团队房间 appendTeamChatEvent：非当前会话未读 +1，正在房间中不自增', async () => {
    await useTeamsStore.getState().appendTeamChatEvent('t1', { from: 'leader-1', to: 'team', content: '进度同步' });
    await flush();
    expect(useChatStore.getState().sessionUnreadCounts[TEAM_SESSION]).toBe(1);
    expect(unreadOf(TEAM_SESSION)).toBe(1);

    // 用户正在该团队房间里（如自己发消息）→ 不计
    resetStores(TEAM_SESSION);
    await useTeamsStore.getState().appendTeamChatEvent('t1', { from: 'user', to: 'team', content: '我发的' });
    await flush();
    expect(useChatStore.getState().sessionUnreadCounts[TEAM_SESSION]).toBeUndefined();
  });

  it('任务会话 appendTaskExecutionEvent：chat: 事件计未读，a2a: trace 噪音不计', async () => {
    await useApprovalsStore.getState().appendTaskExecutionEvent('task1', { type: 'chat:leader-1→user', content: '做好了' });
    await flush();
    expect(useChatStore.getState().sessionUnreadCounts[TASK_SESSION]).toBe(1);
    expect(unreadOf(TASK_SESSION)).toBe(1);

    // a2a trace 高频写回不得计未读
    await useApprovalsStore.getState().appendTaskExecutionEvent('task1', { type: 'a2a:a → b', content: 'trace' });
    await flush();
    expect(useChatStore.getState().sessionUnreadCounts[TASK_SESSION]).toBe(1);
  });
});
