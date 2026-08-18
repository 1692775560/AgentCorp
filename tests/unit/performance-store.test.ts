/**
 * tests/unit/performance-store.test.ts
 *
 * 成员绩效 store（D）单测：
 * - fetchMemberStats：GET /api/member-stats 快照进 store；失败静默保留旧数据
 * - recordOutcomes：POST /api/member-stats/record（body {outcomes}），
 *   用返回快照同步 store；失败静默不抛错（fire-and-forget 语义）
 * - subtasksToOutcomes 纯函数：按 assigneeId 归集，error 子任务记 approved:false，
 *   无 assigneeId 跳过，rounds 下限 1
 *
 * mock @/lib/host-api 为内存实现（参照 teams-store.test.ts）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemberStats } from '@/types/performance';
import type { SubTaskResult } from '@/engine/squad/squadOrchestration';

let stats: Record<string, MemberStats>;
const postCalls: Array<{ path: string; body: unknown }> = [];
let failNextFetch = false;

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    if (failNextFetch) {
      failNextFetch = false;
      throw new Error('host api down');
    }
    if (path === '/api/member-stats' && !init?.method) {
      return { success: true, stats };
    }
    if (path === '/api/member-stats/record' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        outcomes: Array<{ agentId: string; approved: boolean; rounds: number }>;
      };
      postCalls.push({ path, body });
      // 内存模拟服务端逐条增量记录
      for (const o of body.outcomes) {
        const prev = stats[o.agentId] ?? { tasks: 0, passed: 0, totalRounds: 0, updatedAt: '' };
        stats[o.agentId] = {
          tasks: prev.tasks + 1,
          passed: prev.passed + (o.approved ? 1 : 0),
          totalRounds: prev.totalRounds + o.rounds,
          updatedAt: new Date().toISOString(),
        };
      }
      return { success: true, stats };
    }
    throw new Error(`unexpected path: ${path}`);
  }),
}));

import { usePerformanceStore, subtasksToOutcomes } from '@/stores/performance';

function makeSubTask(overrides: Partial<SubTaskResult> = {}): SubTaskResult {
  return {
    title: '子任务',
    assigneeId: 'agent-1',
    assignedBy: 'decompose',
    approved: true,
    rounds: 1,
    output: '产出',
    verdict: 'PASS',
    ...overrides,
  };
}

beforeEach(() => {
  stats = {};
  postCalls.length = 0;
  failNextFetch = false;
  usePerformanceStore.setState({ stats: {} });
});

describe('performance store · fetchMemberStats', () => {
  it('拉全量快照进 store', async () => {
    stats = { 'agent-1': { tasks: 3, passed: 2, totalRounds: 5, updatedAt: '2026-08-18T00:00:00Z' } };
    await usePerformanceStore.getState().fetchMemberStats();
    expect(usePerformanceStore.getState().stats['agent-1'].passed).toBe(2);
  });

  it('拉取失败静默：不抛错，保留旧数据', async () => {
    usePerformanceStore.setState({
      stats: { 'agent-9': { tasks: 1, passed: 1, totalRounds: 1, updatedAt: '' } },
    });
    failNextFetch = true;
    await expect(usePerformanceStore.getState().fetchMemberStats()).resolves.toBeUndefined();
    expect(usePerformanceStore.getState().stats['agent-9'].tasks).toBe(1);
  });
});

describe('performance store · recordOutcomes（fire-and-forget 失败静默）', () => {
  it('POST {outcomes} 批量上报，返回快照同步 store', async () => {
    await usePerformanceStore.getState().recordOutcomes([
      { agentId: 'agent-1', approved: true, rounds: 2 },
      { agentId: 'agent-1', approved: false, rounds: 3 },
      { agentId: 'agent-2', approved: true, rounds: 1 },
    ]);

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0].path).toBe('/api/member-stats/record');
    expect((postCalls[0].body as { outcomes: unknown[] }).outcomes).toHaveLength(3);

    const stored = usePerformanceStore.getState().stats;
    expect(stored['agent-1']).toMatchObject({ tasks: 2, passed: 1, totalRounds: 5 });
    expect(stored['agent-2']).toMatchObject({ tasks: 1, passed: 1, totalRounds: 1 });
  });

  it('空 outcomes 不发请求；上报失败静默不抛错', async () => {
    await usePerformanceStore.getState().recordOutcomes([]);
    expect(postCalls).toHaveLength(0);

    failNextFetch = true;
    await expect(
      usePerformanceStore.getState().recordOutcomes([{ agentId: 'a', approved: true, rounds: 1 }]),
    ).resolves.toBeUndefined();
    expect(usePerformanceStore.getState().stats).toEqual({});
  });
});

describe('subtasksToOutcomes 纯函数（SubTaskResult → MemberOutcome 归集）', () => {
  it('按 assigneeId 归集：每个有归属的子任务产出一条 outcome', () => {
    const outcomes = subtasksToOutcomes([
      makeSubTask({ assigneeId: 'm1', approved: true, rounds: 2 }),
      makeSubTask({ assigneeId: 'm2', approved: false, rounds: 3 }),
      makeSubTask({ assigneeId: 'm1', approved: true, rounds: 1 }),
    ]);
    expect(outcomes).toEqual([
      { agentId: 'm1', approved: true, rounds: 2 },
      { agentId: 'm2', approved: false, rounds: 3 },
      { agentId: 'm1', approved: true, rounds: 1 },
    ]);
  });

  it('error 子任务一律记 approved:false（失败不计贡献）', () => {
    const outcomes = subtasksToOutcomes([
      makeSubTask({ assigneeId: 'm1', approved: true, error: 'LLM 超时', output: null }),
    ]);
    expect(outcomes).toEqual([{ agentId: 'm1', approved: false, rounds: 1 }]);
  });

  it('无 assigneeId 的子任务跳过；rounds 下限 1', () => {
    const outcomes = subtasksToOutcomes([
      makeSubTask({ assigneeId: '' }),
      makeSubTask({ assigneeId: 'm1', approved: true, rounds: 0 }),
    ]);
    expect(outcomes).toEqual([{ agentId: 'm1', approved: true, rounds: 1 }]);
  });
});
