/**
 * tests/unit/leaderboard-source.test.ts
 *
 * 榜单诚实性回归（对应代码审阅 P0-6 / P0-10）：
 *
 *  1. 榜单必须显示人名而非裸 agentId —— 旧实现 runLeaderboard 恒传空 names 映射，
 *     导致评估中心最显眼的一张表永远显示 uuid。
 *  2. 完全降级（judge_source==='degraded'）的条目必须与真实评测条目**分区展示**，
 *     不参与正式排名 —— 未经模型评测的分数没有资格与真实评测并列比较。
 *
 * 隔离：mock 掉落库与采集链路，只测 store 的纯装配逻辑与展示组件的分区判定。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/services/evaluationStore', () => ({
  save: vi.fn(async () => undefined),
  list: vi.fn(async () => []),
}));
vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(async () => undefined),
}));

import { useEvaluationStore } from '@/stores/evaluation';
import { isDegradedEntry } from '@/pages/Evaluation/Leaderboard';
import type { EvaluationProfile, LeaderboardEntry } from '@/types/evaluation';

function makeProfile(
  agentId: string,
  roi: number,
  judgeSource: EvaluationProfile['judgeSource'],
): EvaluationProfile {
  const radar = { task: 3, quality: 3, comm: 3, creativity: 3, reliability: 3, cost: 3 };
  return {
    agentId,
    radarLatest: radar,
    radarHistory: [radar],
    kpiLatest: {
      agent_id: agentId,
      window: '2026-W01',
      task_completion_rate: 0.5,
      rework_rate: 0,
      autonomy_rate: 1,
      escalation_rate: 0,
      avg_latency_ms: 100,
      cross_task_generalization: 0.5,
      stability_consistency: 1,
    } as EvaluationProfile['kpiLatest'],
    kpiHistory: [],
    roiLatest: {
      agent_id: agentId,
      window: '2026-W01',
      value_score: roi,
      cost_usd: 1,
      roi,
    } as EvaluationProfile['roiLatest'],
    lifecycle: 'ACTIVE',
    runIds: [],
    updatedAt: new Date().toISOString(),
    userFitLatest: 60,
    judgeSource,
  };
}

describe('擂台榜单 · 名称与来源', () => {
  beforeEach(() => {
    useEvaluationStore.setState({ profiles: {}, agentNames: {}, leaderboard: [] });
  });

  it('registerAgentNames 后榜单显示人名，未注册时回退 agentId', () => {
    const store = useEvaluationStore.getState();
    useEvaluationStore.setState({
      profiles: {
        'agent-uuid-1': makeProfile('agent-uuid-1', 2, 'judge'),
        'agent-uuid-2': makeProfile('agent-uuid-2', 1, 'judge'),
      },
    });
    store.registerAgentNames({ 'agent-uuid-1': '代码审查员' });

    const board = useEvaluationStore.getState().leaderboard;
    const first = board.find((e) => e.agentId === 'agent-uuid-1') as LeaderboardEntry;
    const second = board.find((e) => e.agentId === 'agent-uuid-2') as LeaderboardEntry;
    expect(first.name).toBe('代码审查员');
    // 未注册的仍回退 agentId（而不是空串）
    expect(second.name).toBe('agent-uuid-2');
  });

  it('榜单条目携带 judge_source，用于分区展示', () => {
    useEvaluationStore.setState({
      profiles: {
        a: makeProfile('a', 3, 'judge'),
        b: makeProfile('b', 2, 'mixed'),
        c: makeProfile('c', 1, 'degraded'),
      },
    });
    useEvaluationStore.getState().runLeaderboard();
    const board = useEvaluationStore.getState().leaderboard;
    const byId = Object.fromEntries(board.map((e) => [e.agentId, e]));
    expect(byId.a.judge_source).toBe('judge');
    expect(byId.b.judge_source).toBe('mixed');
    expect(byId.c.judge_source).toBe('degraded');
  });

  it('只有完全降级的条目被排除出正式榜（mixed 仍参与排名）', () => {
    useEvaluationStore.setState({
      profiles: {
        a: makeProfile('a', 3, 'judge'),
        b: makeProfile('b', 2, 'mixed'),
        c: makeProfile('c', 1, 'degraded'),
        d: makeProfile('d', 0.5, null),
      },
    });
    useEvaluationStore.getState().runLeaderboard();
    const board = useEvaluationStore.getState().leaderboard;
    const ranked = board.filter((e) => !isDegradedEntry(e)).map((e) => e.agentId);
    const degraded = board.filter(isDegradedEntry).map((e) => e.agentId);
    expect(ranked).toContain('a');
    expect(ranked).toContain('b');
    // 历史数据（无来源标注）不误伤：仍留在正式榜
    expect(ranked).toContain('d');
    expect(degraded).toEqual(['c']);
  });
});
