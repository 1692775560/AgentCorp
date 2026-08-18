/**
 * tests/unit/teams-store-append-order.test.ts
 *
 * Bug B5：appendTeamChatEvent 服务端响应是全量 teams 快照，编排期间 trace 广播
 * 并发打多条 append，响应乱序到达时旧快照后到会覆盖新快照，后追加的消息从 UI 消失。
 * 修复：按 teamId 串行化 append 请求（每团队一条 promise 链，后一次等前一次完成再发），
 * 响应顺序即发送顺序；前一次失败 catch 续链，不阻断后续 append。
 *
 * mock hostApiFetch 为「请求到达即落库、快照随响应返回」的 deferred 实现，
 * 响应顺序由测试手动控制，可复现乱序覆盖场景。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TeamSummary, TeamsSnapshot, TeamChatEvent } from '@/types/team';

function makeTeam(id: string, chatEvents: TeamChatEvent[] = []): TeamSummary {
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

interface PendingAppend {
  teamId: string;
  body: Omit<TeamChatEvent, 'createdAt'>;
  /** 服务端 append 成功后生成的快照（resolve 时落库生成），随响应返回 */
  snapshot: TeamsSnapshot;
  resolve: () => void;
  reject: (e: unknown) => void;
}

let teams: TeamSummary[];
let pending: PendingAppend[];

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn((path: string, init?: RequestInit) => {
    const appendMatch = path.match(/^\/api\/teams\/(.+)\/chat-events$/);
    if (appendMatch && init?.method === 'POST') {
      const teamId = decodeURIComponent(appendMatch[1]);
      const body = JSON.parse(String(init.body)) as Omit<TeamChatEvent, 'createdAt'>;
      // 服务端原子 append：处理成功才落库并生成快照，响应可延迟/乱序送达
      return new Promise<TeamsSnapshot>((resolve, reject) => {
        const entry = {} as PendingAppend;
        entry.resolve = () => {
          teams = teams.map((t) =>
            t.id === teamId
              ? {
                  ...t,
                  chatEvents: [
                    ...(t.chatEvents ?? []),
                    { ...body, createdAt: new Date().toISOString() },
                  ],
                }
              : t,
          );
          entry.snapshot = { teams } satisfies TeamsSnapshot;
          resolve(entry.snapshot);
        };
        entry.reject = reject;
        entry.teamId = teamId;
        entry.body = body;
        pending.push(entry);
      });
    }
    throw new Error(`unexpected path: ${path}`);
  }),
}));

import { useTeamsStore } from '@/stores/teams';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const append = (teamId: string, content: string) =>
  useTeamsStore.getState().appendTeamChatEvent(teamId, {
    from: 'leader-1',
    to: 'user',
    content,
  });

const storedContents = (teamId: string) =>
  useTeamsStore.getState().teams.find((t) => t.id === teamId)!.chatEvents!.map((e) => e.content);

beforeEach(() => {
  teams = [makeTeam('team-a'), makeTeam('team-b')];
  pending = [];
  useTeamsStore.setState({
    teams: [makeTeam('team-a'), makeTeam('team-b')],
    loading: false,
    error: null,
  });
});

describe('appendTeamChatEvent 按 teamId 串行化（Bug B5）', () => {
  it('两个并发 append：第二个等第一个响应后才发出，最终两条都在且顺序正确', async () => {
    const p1 = append('team-a', 'msg-1');
    const p2 = append('team-a', 'msg-2');
    await flush();

    // 串行化关键断言：第一个响应未回时，第二个请求不能发出
    // （若并发发出，第二个响应先回、第一个旧快照后回就会把 msg-2 覆盖掉）
    expect(pending).toHaveLength(1);
    expect(pending[0].body.content).toBe('msg-1');

    pending[0].resolve();
    await flush();
    expect(pending).toHaveLength(2);
    expect(pending[1].body.content).toBe('msg-2');

    pending[1].resolve();
    await Promise.all([p1, p2]);

    expect(storedContents('team-a')).toEqual(['msg-1', 'msg-2']);
  });

  it('前一次 append 失败不阻断后续 append（catch 续链）', async () => {
    const p1 = append('team-a', 'msg-1');
    const p2 = append('team-a', 'msg-2');
    await flush();
    expect(pending).toHaveLength(1);

    pending[0].reject(new Error('network down'));
    await expect(p1).rejects.toThrow('network down');
    await flush();

    // 链不断：第二个请求照常发出并成功
    expect(pending).toHaveLength(2);
    pending[1].resolve();
    await p2;

    expect(storedContents('team-a')).toEqual(['msg-2']);
  });

  it('不同 teamId 各有独立链，互不阻塞', async () => {
    const pa = append('team-a', 'msg-a');
    const pb = append('team-b', 'msg-b');
    await flush();

    // 两个团队的请求都立即发出
    expect(pending).toHaveLength(2);

    // team-b 的响应先回，不影响 team-a
    pending[1].resolve();
    await flush();
    expect(storedContents('team-b')).toEqual(['msg-b']);

    pending[0].resolve();
    await Promise.all([pa, pb]);
    expect(storedContents('team-a')).toEqual(['msg-a']);
  });
});
