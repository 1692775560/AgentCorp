import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatStore, type ChatSession } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';

// loadSessions 合并语义：网关 sessions.list 回来后不能再整体替换本地 sessions——
// team:（团队房间）、team-task:（任务会话）、:private-（私聊）是纯本地条目，
// 整体替换会把它们从侧边栏冲掉（"新进入时没有团队会话"的根因）。
const TEAM_ROOM_KEY = 'team:team-1';
const TEAM_TASK_KEY = 'team-task:task-9';
const PRIVATE_KEY = 'agent:pm:private-pm';

const rpcMock = vi.fn<(method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>>();

let gatewaySessions: Array<Record<string, unknown>> = [];
// 模块级节流（SESSION_LOAD_MIN_INTERVAL_MS）跨用例生效，用单调递增的系统时间绕过
let nowSeed = 1_800_000_000_000;

function resetStore(localSessions: ChatSession[] = []) {
  useAgentsStore.setState({ agents: [], agentStatuses: {} } as never);
  useChatStore.setState({
    sessions: localSessions,
    sessionLabels: {},
    sessionLastActivity: {},
    sessionUnreadCounts: {},
    messages: [],
    currentSessionKey: 'agent:main:main',
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
}

async function flush() {
  await vi.advanceTimersByTimeAsync(20);
}

describe('loadSessions 合并语义', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    gatewaySessions = [];
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') return { sessions: gatewaySessions };
      return { messages: [] };
    });
    useGatewayStore.setState({ rpc: rpcMock } as never);
    vi.useFakeTimers();
    nowSeed += 10_000;
    vi.setSystemTime(nowSeed);
    resetStore();
  });

  afterEach(async () => {
    await flush();
    vi.useRealTimers();
  });

  it('网关列表没有 team:/team-task:/private 条目时，本地条目保留', async () => {
    resetStore([
      { key: TEAM_ROOM_KEY, displayName: '战队一', isTeamSession: true, teamId: 'team-1', updatedAt: nowSeed - 3000 },
      { key: TEAM_TASK_KEY, displayName: '团队任务 · 写周报', isTeamSession: true, teamTaskId: 'task-9', updatedAt: nowSeed - 2000 },
      { key: PRIVATE_KEY, displayName: '产品经理', isPrivateChat: true, agentId: 'pm', targetAgentId: 'pm', updatedAt: nowSeed - 1000 },
    ]);
    gatewaySessions = [{ key: 'agent:main:session-abc', updatedAt: nowSeed }];

    await useChatStore.getState().loadSessions();

    const keys = useChatStore.getState().sessions.map((s) => s.key);
    expect(keys).toContain(TEAM_ROOM_KEY);
    expect(keys).toContain(TEAM_TASK_KEY);
    expect(keys).toContain(PRIVATE_KEY);
    expect(keys).toContain('agent:main:session-abc');

    const room = useChatStore.getState().sessions.find((s) => s.key === TEAM_ROOM_KEY);
    expect(room?.isTeamSession).toBe(true);
    expect(room?.displayName).toBe('战队一');
    const task = useChatStore.getState().sessions.find((s) => s.key === TEAM_TASK_KEY);
    expect(task?.teamTaskId).toBe('task-9');
    await flush();
  });

  it('网关返回同 key 私聊条目时，元数据合并且不覆盖本地标记', async () => {
    resetStore([
      {
        key: PRIVATE_KEY,
        displayName: '产品经理',
        isPrivateChat: true,
        isLeaderChat: false,
        isTeamSession: false,
        agentId: 'pm',
        targetAgentId: 'pm',
        teamId: 'team-1',
        updatedAt: nowSeed - 1000,
      },
    ]);
    gatewaySessions = [
      { key: PRIVATE_KEY, updatedAt: nowSeed, model: 'gpt-5', displayName: '网关裸条目名' },
      { key: 'agent:main:session-abc', updatedAt: nowSeed },
    ];

    await useChatStore.getState().loadSessions();

    const merged = useChatStore.getState().sessions.filter((s) => s.key === PRIVATE_KEY);
    expect(merged).toHaveLength(1);
    // 本地标记保留
    expect(merged[0].isPrivateChat).toBe(true);
    expect(merged[0].isTeamSession).toBe(false);
    expect(merged[0].targetAgentId).toBe('pm');
    expect(merged[0].displayName).toBe('产品经理');
    // 网关侧元数据照常更新
    expect(merged[0].model).toBe('gpt-5');
    expect(merged[0].updatedAt).toBe(nowSeed);
    await flush();
  });

  it('普通 agent 会话仍按网关列表整体更新', async () => {
    resetStore([
      { key: 'agent:main:session-old', displayName: '旧会话', updatedAt: nowSeed - 5000 },
    ]);
    gatewaySessions = [{ key: 'agent:main:session-new', updatedAt: nowSeed, label: '新会话' }];

    await useChatStore.getState().loadSessions();

    const keys = useChatStore.getState().sessions.map((s) => s.key);
    expect(keys).toContain('agent:main:session-new');
    expect(keys).not.toContain('agent:main:session-old');
    await flush();
  });

  it('ensureTeamSession 幂等：重复调用不产生重复条目，团队改名同步显示名', async () => {
    resetStore();
    const ensure = useChatStore.getState().ensureTeamSession;

    ensure({ id: 'team-1', name: '战队一' });
    ensure({ id: 'team-1', name: '战队一' });
    expect(useChatStore.getState().sessions.filter((s) => s.key === TEAM_ROOM_KEY)).toHaveLength(1);

    ensure({ id: 'team-1', name: '战队一改名了' });
    const rooms = useChatStore.getState().sessions.filter((s) => s.key === TEAM_ROOM_KEY);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].displayName).toBe('战队一改名了');

    // loadSessions 之后依然只有一条
    gatewaySessions = [{ key: 'agent:main:session-abc', updatedAt: nowSeed }];
    await useChatStore.getState().loadSessions();
    expect(useChatStore.getState().sessions.filter((s) => s.key === TEAM_ROOM_KEY)).toHaveLength(1);
    await flush();
  });
});
