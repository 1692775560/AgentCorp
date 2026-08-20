/**
 * tests/unit/team-chat-events.test.ts
 *
 * Bug 2：POST /api/teams/:id/chat-events 服务端原子 append 端点。
 * - appendTeamChatEvent 在 withConfigLock 内读-改-写：补 createdAt、封顶 200 条裁最旧；
 *   截断时保留「未处置」的立项草稿卡（[task-draft] 无对应 resolution），
 *   最多额外保留 10 张，超出的最旧未处置卡视为作废允许裁掉（Bug B6）；
 * - 并发 append 不丢消息（锁串行化）；
 * - 路由：200 返回 teams 快照 / 400 缺字段 / 404 team 不存在。
 *
 * openclaw-runtime-metadata 用内存替身，channel-config / agent-config / task-config
 * 全部 mock，不碰真实文件系统与 electron。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Team } from '../../src/types/team';

let storedTeams: Team[] = [];

vi.mock('../../electron/utils/openclaw-runtime-metadata', () => ({
  readStoredTeams: vi.fn(async () => storedTeams.map((t) => ({ ...t }))),
  writeStoredTeams: vi.fn(async (teams: Team[]) => {
    storedTeams = teams.map((t) => ({ ...t }));
  }),
}));

vi.mock('../../electron/utils/channel-config', () => ({
  readOpenClawConfig: vi.fn(async () => ({})),
  writeOpenClawConfig: vi.fn(async () => {}),
}));

vi.mock('../../electron/utils/agent-config', () => ({
  listAgentsSnapshot: vi.fn(async () => ({ agents: [] })),
  writeAgentSoulMd: vi.fn(async () => {}),
}));

vi.mock('../../electron/utils/task-config', () => ({
  listTaskSnapshots: vi.fn(async () => []),
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../electron/utils/channel-owner-binding', () => ({
  clearChannelOwnerBindingsForTeam: vi.fn(async () => {}),
}));

const { appendTeamChatEvent } = await import('../../electron/utils/team-config');
const { handleTeamRoutes } = await import('../../electron/api/routes/teams');

function makeTeam(id: string, chatEvents?: Team['chatEvents']): Team {
  return {
    id,
    name: `团队-${id}`,
    leaderId: 'agent-leader',
    memberIds: ['agent-1'],
    description: '',
    status: 'idle',
    ...(chatEvents ? { chatEvents } : {}),
    createdAt: 1,
    updatedAt: 1,
  };
}

function fakeReq(method: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  const req = stream as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { headers?: Record<string, string> }).headers = {};
  return req;
}

function fakeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let statusCode = 0;
  let payload: Record<string, unknown> | undefined;
  const res = {
    setHeader: () => {},
    end: (data?: string) => {
      payload = data ? JSON.parse(data) as Record<string, unknown> : undefined;
    },
  } as unknown as ServerResponse;
  Object.defineProperty(res, 'statusCode', {
    get: () => statusCode,
    set: (v: number) => { statusCode = v; },
  });
  return { res, status: () => statusCode, body: () => payload ?? {} };
}

const ctx = {} as Parameters<typeof handleTeamRoutes>[3];

beforeEach(() => {
  storedTeams = [];
});

describe('appendTeamChatEvent', () => {
  it('追加事件：补 createdAt、更新 updatedAt、返回最新 teams 快照', async () => {
    storedTeams = [makeTeam('t1')];

    const teams = await appendTeamChatEvent('t1', { from: 'user', to: 'agent-leader', content: '早上好' });

    const team = teams.find((t) => t.id === 't1')!;
    expect(team.chatEvents).toHaveLength(1);
    expect(team.chatEvents![0]).toMatchObject({ from: 'user', to: 'agent-leader', content: '早上好' });
    expect(typeof team.chatEvents![0].createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(team.chatEvents![0].createdAt))).toBe(false);
    expect(team.updatedAt).toBeGreaterThan(1);
    // 存储层也真的落了
    expect(storedTeams[0].chatEvents).toHaveLength(1);
  });

  it('已有 200 条时再 append：仍 200 条、裁掉最旧、新事件在末尾', async () => {
    const existing = Array.from({ length: 200 }, (_, i) => ({
      from: 'user',
      to: 'agent-leader',
      content: `e${i}`,
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    storedTeams = [makeTeam('t1', existing)];

    const teams = await appendTeamChatEvent('t1', { from: 'agent-leader', to: 'user', content: '新消息' });

    const events = teams[0].chatEvents!;
    expect(events).toHaveLength(200);
    expect(events[0].content).toBe('e1');
    expect(events[199].content).toBe('新消息');
    expect(events.some((e) => e.content === 'e0')).toBe(false);
  });

  it('team 不存在 → 抛 Team not found', async () => {
    storedTeams = [makeTeam('t1')];
    await expect(
      appendTeamChatEvent('ghost', { from: 'user', to: 'a', content: 'x' }),
    ).rejects.toThrow(/Team not found/);
  });

  it('并发 append 不丢消息（withConfigLock 串行化读-改-写）', async () => {
    storedTeams = [makeTeam('t1')];

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        appendTeamChatEvent('t1', { from: 'user', to: 'agent-leader', content: `msg-${i}` }),
      ),
    );

    const events = storedTeams[0].chatEvents!;
    expect(events).toHaveLength(50);
    const contents = new Set(events.map((e) => e.content));
    for (let i = 0; i < 50; i += 1) {
      expect(contents.has(`msg-${i}`)).toBe(true);
    }
  });
});

describe('appendTeamChatEvent 截断保留未处置立项草稿卡（Bug B6）', () => {
  // 与 src/lib/team-task-chat.ts 协议格式一致：[task-draft]{"id","title","requirement"}
  const draftContent = (id: string) =>
    `[task-draft]${JSON.stringify({ id, title: `任务-${id}`, requirement: '需求' })}`;
  const resolutionContent = (id: string, action: string) =>
    `[task-draft-resolution]${JSON.stringify({ id, action })}`;
  const trace = (i: number) => ({
    from: 'agent-leader',
    to: 'agent-1',
    content: `trace-${i}`,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const draftEvent = (id: string) => ({
    from: 'agent-leader',
    to: 'user',
    content: draftContent(id),
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('200 条已满且最旧一条是未处置草稿卡：append 后草稿卡保留，普通事件照常裁最旧', async () => {
    storedTeams = [
      makeTeam('t1', [draftEvent('d1'), ...Array.from({ length: 199 }, (_, i) => trace(i))]),
    ];

    const teams = await appendTeamChatEvent('t1', { from: 'user', to: 'agent-leader', content: '新消息' });

    const events = teams[0].chatEvents!;
    expect(events.some((e) => e.content === draftContent('d1'))).toBe(true); // 未处置草稿卡保留
    expect(events.some((e) => e.content === 'trace-0')).toBe(false); // 最旧的普通事件被裁
    expect(events[events.length - 1].content).toBe('新消息');
    expect(events.length).toBeLessThanOrEqual(201); // 200 普通位 + 额外保留的草稿卡
  });

  it('已 confirmed 的草稿卡不享受保留：位于最旧时照常裁掉', async () => {
    storedTeams = [
      makeTeam('t1', [
        draftEvent('d1'),
        { from: 'user', to: 'agent-leader', content: resolutionContent('d1', 'confirmed'), createdAt: '2026-01-01T00:00:01.000Z' },
        ...Array.from({ length: 198 }, (_, i) => trace(i)),
      ]),
    ];

    const teams = await appendTeamChatEvent('t1', { from: 'user', to: 'agent-leader', content: '新消息' });

    const events = teams[0].chatEvents!;
    expect(events).toHaveLength(200);
    expect(events.some((e) => e.content === draftContent('d1'))).toBe(false); // 已处置，被裁
    expect(events.some((e) => e.content === resolutionContent('d1', 'confirmed'))).toBe(true);
    expect(events[events.length - 1].content).toBe('新消息');
  });

  it('未处置草稿卡超过 10 张时：最旧的视为作废允许裁掉（防病态累积）', async () => {
    storedTeams = [
      makeTeam('t1', [
        ...Array.from({ length: 12 }, (_, i) => draftEvent(`d${i}`)),
        ...Array.from({ length: 188 }, (_, i) => trace(i)),
      ]),
    ];

    const teams = await appendTeamChatEvent('t1', { from: 'user', to: 'agent-leader', content: '新消息' });

    const events = teams[0].chatEvents!;
    expect(events).toHaveLength(200);
    expect(events.some((e) => e.content === draftContent('d0'))).toBe(false); // 最旧的未处置卡作废被裁
    // 其余 11 张未处置卡都保留
    for (let i = 1; i < 12; i += 1) {
      expect(events.some((e) => e.content === draftContent(`d${i}`))).toBe(true);
    }
    expect(events[events.length - 1].content).toBe('新消息');
  });
});

describe('POST /api/teams/:id/chat-events 路由', () => {
  it('正常 append → 200 + teams 快照包含新事件', async () => {
    storedTeams = [makeTeam('t1')];

    const { res, status, body } = fakeRes();
    const handled = await handleTeamRoutes(
      fakeReq('POST', { from: 'user', to: 'agent-leader', content: 'hello' }),
      res,
      new URL('http://localhost/api/teams/t1/chat-events'),
      ctx,
    );

    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(body().success).toBe(true);
    const teams = body().teams as Team[];
    expect(teams[0].chatEvents).toHaveLength(1);
    expect(teams[0].chatEvents![0].content).toBe('hello');
  });

  it('缺 content → 400', async () => {
    storedTeams = [makeTeam('t1')];

    const { res, status, body } = fakeRes();
    await handleTeamRoutes(
      fakeReq('POST', { from: 'user', to: 'agent-leader' }),
      res,
      new URL('http://localhost/api/teams/t1/chat-events'),
      ctx,
    );

    expect(status()).toBe(400);
    expect(body().success).toBe(false);
    expect(storedTeams[0].chatEvents).toBeUndefined();
  });

  it('team 不存在 → 404', async () => {
    storedTeams = [makeTeam('t1')];

    const { res, status, body } = fakeRes();
    await handleTeamRoutes(
      fakeReq('POST', { from: 'user', to: 'a', content: 'x' }),
      res,
      new URL('http://localhost/api/teams/ghost/chat-events'),
      ctx,
    );

    expect(status()).toBe(404);
    expect(body().success).toBe(false);
  });

  it('不走 chat-events 的 POST /api/teams 仍归创建分支处理', async () => {
    const { res, status } = fakeRes();
    const handled = await handleTeamRoutes(
      fakeReq('POST', {}),
      res,
      new URL('http://localhost/api/teams'),
      ctx,
    );

    expect(handled).toBe(true);
    expect(status()).toBe(400); // leaderId is required
  });
});
