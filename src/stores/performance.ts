/**
 * src/stores/performance.ts
 * 成员绩效 store（D：DyLAN 贡献度思想，arXiv:2310.02170，见 types/performance.ts）。
 *
 * 数据闭环的渲染层一侧：
 * - fetchMemberStats：拉全量快照进 store（编排前调用，供 projectRoutingCandidates
 *   把 toPerformance(stats) 注入 RoutingCandidate.performance）。
 * - recordOutcomes：编排完成后把子任务结果归集上报（fire-and-forget，
 *   失败静默——绩效统计是增强信号，绝不能阻塞交付主链路）。
 *
 * subtasksToOutcomes 是纯函数（可单测）：SubTaskResult[] → MemberOutcome[]。
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import type { MemberOutcome, MemberStats, MemberStatsSnapshot } from '@/types/performance';
import type { SubTaskResult } from '@/engine/squad/squadOrchestration';

/**
 * 把编排结果的子任务列表按 assigneeId 归集成上报用 outcome：
 * - 无 assigneeId 的子任务跳过（无法归因）；
 * - 执行出错（error 非空）一律记 approved:false（DyLAN 贡献度：失败不计贡献）；
 * - rounds 下限 1（至少执行了一轮）。
 */
export function subtasksToOutcomes(subtasks: SubTaskResult[]): MemberOutcome[] {
  return subtasks
    .filter((s) => Boolean(s.assigneeId))
    .map((s) => ({
      agentId: s.assigneeId,
      approved: s.error ? false : Boolean(s.approved),
      rounds: Math.max(1, Math.round(s.rounds ?? 1)),
    }));
}

interface PerformanceState {
  /** agentId → 累计绩效（最近一次快照）。 */
  stats: Record<string, MemberStats>;

  /** 拉全量快照；失败静默（保留旧数据）。 */
  fetchMemberStats: () => Promise<void>;
  /** 批量上报 outcome 并用返回快照同步 store；fire-and-forget，失败静默。 */
  recordOutcomes: (outcomes: MemberOutcome[]) => Promise<void>;
}

export const usePerformanceStore = create<PerformanceState>((set) => ({
  stats: {},

  fetchMemberStats: async () => {
    try {
      const snapshot = await hostApiFetch<MemberStatsSnapshot>('/api/member-stats');
      set({ stats: snapshot?.stats ?? {} });
    } catch {
      /* 绩效拉取失败静默：路由缺少绩效信号时退回无绩效画像 */
    }
  },

  recordOutcomes: async (outcomes) => {
    if (outcomes.length === 0) return;
    try {
      const snapshot = await hostApiFetch<MemberStatsSnapshot>('/api/member-stats/record', {
        method: 'POST',
        body: JSON.stringify({ outcomes }),
      });
      if (snapshot?.stats) set({ stats: snapshot.stats });
    } catch {
      /* 上报失败静默：不阻塞交付，下轮任务会带上最新快照重试 */
    }
  },
}));
