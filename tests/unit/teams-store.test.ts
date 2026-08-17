/**
 * tests/unit/teams-store.test.ts
 *
 * useTeamsStore.appendTeamChatEvent（团队房间消息追加）单测：
 * - 追加事件带 createdAt，经 PUT /api/teams/:id 持久化，store 状态同步
 * - 未知 teamId → 无操作（不发起 PUT）
 * - chatEvents 封顶 200 条（slice(-200)）
 *
 * mock @/lib/host-api 为内存实现，模拟主进程快照返回。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TeamSummary, TeamsSnapshot, UpdateTeamRequest } from '@/types/team';

function makeTeam(id: string, chatEvents: TeamsSnapshot['teams'][number]['chatEvents'] = []): TeamSummary {
  return {
    id,
    name: `团队-${id}`,
    leaderId: 'leader-1',
    memberIds: ['m-1'],
    createdAt: 0,
    chatEvents,
    memberCount: 2,
    activeTaskCount: 0,
    lastActiveTime: undefined,
    leaderName: 'Leader',
    memberAvatars: [],
  };
}

let teams: TeamSummary[];
const putCalls: Array<{ teamId: string; body: UpdateTeamRequest }> = [];

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/teams') {
      return { teams } satisfies TeamsSnapshot;
    }
    const putMatch = path.match(/^\/api\/teams\/(.+)$/);
    if (putMatch && init?.method === 'PUT') {
      const teamId = decodeURIComponent(putMatch[1]);
      const body = JSON.parse(String(init.body)) as UpdateTeamRequest;
      putCalls.push({ teamId, body });
      teams = teams.map((t) => (t.id === teamId ? { ...t, ...body } : t));
      return { teams } satisfies TeamsSnapshot;
    }
    throw new Error(`unexpected path: ${path}`);
  }),
}));

import { useTeamsStore } from '@/stores/teams';

beforeEach(() => {
  teams = [makeTeam('team-a')];
  putCalls.length = 0;
  useTeamsStore.setState({ teams: [makeTeam('team-a')], loading: false, error: null });
});

describe('appendTeamChatEvent', () => {
  it('追加事件：补 createdAt、PUT 持久化、store 状态同步', async () => {
    await useTeamsStore.getState().appendTeamChatEvent('team-a', {
      from: 'leader-1',
      to: 'user',
      content: '「计算器」交付完成，请验收',
    });

    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].teamId).toBe('team-a');
    const events = putCalls[0].body.chatEvents!;
    expect(events).toHaveLength(1);
    expect(events[0].from).toBe('leader-1');
    expect(events[0].to).toBe('user');
    expect(events[0].content).toContain('交付完成');
    expect(typeof events[0].createdAt).toBe('string');
    expect(events[0].createdAt.length).toBeGreaterThan(0);

    // store 状态同步
    const stored = useTeamsStore.getState().teams.find((t) => t.id === 'team-a')!;
    expect(stored.chatEvents).toHaveLength(1);
  });

  it('未知 teamId → 无操作（不发起 PUT）', async () => {
    await useTeamsStore.getState().appendTeamChatEvent('team-x', {
      from: 'leader-1',
      to: 'user',
      content: 'hi',
    });
    expect(putCalls).toHaveLength(0);
  });

  it('chatEvents 封顶 200 条：已满 200 时再追加仍保持 200 且最新在最尾', async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({
      from: 'leader-1',
      to: 'user',
      content: `msg-${i}`,
      createdAt: new Date(i).toISOString(),
    }));
    teams = [makeTeam('team-a', full)];
    useTeamsStore.setState({ teams: [makeTeam('team-a', full)] });

    await useTeamsStore.getState().appendTeamChatEvent('team-a', {
      from: 'leader-1',
      to: 'user',
      content: '新消息',
    });

    const events = putCalls[0].body.chatEvents!;
    expect(events).toHaveLength(200);
    expect(events[0].content).toBe('msg-1'); // 最旧的一条被挤出
    expect(events[199].content).toBe('新消息');
  });
});
