/**
 * tests/unit/experience-store.test.ts
 *
 * 团队经验卡 store（F）单测：
 * - getExperience：GET /api/teams/:id/experience，进 store 并返回；失败静默返回 []
 * - appendExperience：POST 同路径（body {content, source}），返回快照同步 store；失败静默
 * - buildExperienceText 纯函数：最近 10 条、每行「- 内容」、空数组 → undefined
 * - buildReflectionPrompt 纯函数：含任务标题与各子任务通过/返工/失败情况
 * - reflectExperience：chat 产出非空 → append（source 记 taskId）；
 *   空产出不 append；chat 抛错静默返回 false
 *
 * mock @/lib/host-api 为内存实现（参照 teams-store.test.ts）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExperienceCard } from '@/types/experience';
import type { SubTaskResult } from '@/engine/squad/squadOrchestration';

let cardsByTeam: Record<string, ExperienceCard[]>;
const appendCalls: Array<{ teamId: string; body: { content: string; source?: string } }> = [];
let failNextFetch = false;

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    if (failNextFetch) {
      failNextFetch = false;
      throw new Error('host api down');
    }
    const match = path.match(/^\/api\/teams\/(.+)\/experience$/);
    if (!match) throw new Error(`unexpected path: ${path}`);
    const teamId = decodeURIComponent(match[1]);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { content: string; source?: string };
      appendCalls.push({ teamId, body });
      // 内存模拟服务端：补 id/createdAt、封顶 20
      const card: ExperienceCard = {
        id: `exp-${appendCalls.length}`,
        content: body.content,
        source: body.source ?? '',
        createdAt: new Date().toISOString(),
      };
      cardsByTeam[teamId] = [...(cardsByTeam[teamId] ?? []), card].slice(-20);
    }
    return { success: true, cards: cardsByTeam[teamId] ?? [] };
  }),
}));

import {
  useExperienceStore,
  buildExperienceText,
  buildReflectionPrompt,
  reflectExperience,
  EXPERIENCE_INJECT_LIMIT,
} from '@/stores/experience';

function makeCard(content: string, source = 'task-x'): ExperienceCard {
  return { id: `exp-${content}`, content, source, createdAt: new Date().toISOString() };
}

function makeSubTask(overrides: Partial<SubTaskResult> = {}): SubTaskResult {
  return {
    title: '子任务',
    assigneeId: 'm1',
    assignedBy: 'decompose',
    approved: true,
    rounds: 1,
    output: '产出',
    verdict: 'PASS',
    ...overrides,
  };
}

beforeEach(() => {
  cardsByTeam = {};
  appendCalls.length = 0;
  failNextFetch = false;
  useExperienceStore.setState({ cardsByTeam: {} });
});

describe('experience store · getExperience / appendExperience', () => {
  it('GET 拉卡进 store 并返回；POST append（source 记 taskId）后快照同步', async () => {
    cardsByTeam['team-a'] = [makeCard('存量经验')];

    const cards = await useExperienceStore.getState().getExperience('team-a');
    expect(cards).toHaveLength(1);
    expect(useExperienceStore.getState().cardsByTeam['team-a']).toHaveLength(1);

    await useExperienceStore.getState().appendExperience('team-a', '新经验：先定接口', 'task-42');
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]).toEqual({ teamId: 'team-a', body: { content: '新经验：先定接口', source: 'task-42' } });
    const stored = useExperienceStore.getState().cardsByTeam['team-a'];
    expect(stored).toHaveLength(2);
    expect(stored[1].source).toBe('task-42');
  });

  it('失败静默：GET 抛错返回 []，POST 抛错不抛出', async () => {
    failNextFetch = true;
    await expect(useExperienceStore.getState().getExperience('team-a')).resolves.toEqual([]);

    failNextFetch = true;
    await expect(
      useExperienceStore.getState().appendExperience('team-a', 'x', 't'),
    ).resolves.toBeUndefined();
    expect(useExperienceStore.getState().cardsByTeam['team-a']).toBeUndefined();
  });
});

describe('buildExperienceText 纯函数（经验卡 → 注入文本）', () => {
  it('无卡 → undefined（不注入编排）', () => {
    expect(buildExperienceText([])).toBeUndefined();
  });

  it('每行「- 内容」；超过上限时只取最近 N 条', () => {
    const cards = Array.from({ length: EXPERIENCE_INJECT_LIMIT + 2 }, (_, i) => makeCard(`经验-${i}`));
    const text = buildExperienceText(cards)!;
    const lines = text.split('\n');
    expect(lines).toHaveLength(EXPERIENCE_INJECT_LIMIT);
    expect(lines[0]).toBe('- 经验-2'); // 最旧 2 条不注入
    expect(lines[lines.length - 1]).toBe(`- 经验-${EXPERIENCE_INJECT_LIMIT + 1}`);
  });
});

describe('buildReflectionPrompt 纯函数（leader 复盘 prompt）', () => {
  it('含任务标题 + 各子任务通过/返工/失败情况 + ≤150 字要求', () => {
    const prompt = buildReflectionPrompt('做竞品调研', [
      makeSubTask({ title: '收集资料', assigneeId: 'm1', approved: true, rounds: 1 }),
      makeSubTask({ title: '写报告', assigneeId: 'm2', approved: true, rounds: 3 }),
      makeSubTask({ title: '画图表', assigneeId: 'm3', approved: false, rounds: 2, error: '超时', output: null }),
      makeSubTask({ title: '校对', assigneeId: 'm4', approved: false, rounds: 2 }),
    ]);
    expect(prompt).toContain('做竞品调研');
    expect(prompt).toContain('收集资料');
    expect(prompt).toContain('一次通过');
    expect(prompt).toContain('返工 2 次后过关'); // rounds=3 → 返工 2 次
    expect(prompt).toContain('失败（超时）');
    expect(prompt).toContain('未通过');
    expect(prompt).toContain('150');
  });
});

describe('reflectExperience（交付后复盘落卡，全链路失败静默）', () => {
  it('chat 产出非空 → append 一条，source 记 taskId，返回 true', async () => {
    const ok = await reflectExperience({
      teamId: 'team-a',
      taskId: 'task-7',
      taskTitle: '做调研',
      subtasks: [makeSubTask({ title: '收集', assigneeId: 'm1' })],
      chat: vi.fn(async () => '  调研类任务先让成员列提纲再展开，可减少返工。  '),
    });
    expect(ok).toBe(true);
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0].teamId).toBe('team-a');
    expect(appendCalls[0].body.source).toBe('task-7');
    expect(appendCalls[0].body.content).toBe('调研类任务先让成员列提纲再展开，可减少返工。');
  });

  it('chat 空产出 → 不 append，返回 false', async () => {
    const ok = await reflectExperience({
      teamId: 'team-a',
      taskId: 'task-8',
      taskTitle: '做调研',
      subtasks: [makeSubTask()],
      chat: vi.fn(async () => '   '),
    });
    expect(ok).toBe(false);
    expect(appendCalls).toHaveLength(0);
  });

  it('无子任务 → 直接 false；chat 抛错 → 静默 false（不阻塞交付）', async () => {
    expect(
      await reflectExperience({
        teamId: 'team-a', taskId: 't', taskTitle: 'x', subtasks: [], chat: vi.fn(),
      }),
    ).toBe(false);

    const ok = await reflectExperience({
      teamId: 'team-a',
      taskId: 'task-9',
      taskTitle: '做调研',
      subtasks: [makeSubTask()],
      chat: vi.fn(async () => { throw new Error('LLM 超时'); }),
    });
    expect(ok).toBe(false);
    expect(appendCalls).toHaveLength(0);
  });
});
