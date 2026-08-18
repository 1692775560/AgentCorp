/**
 * 成员绩效统计类型（D：DyLAN 贡献度思想，arXiv:2310.02170）。
 *
 * DyLAN（Dynamic LLM-Agent Network）按各 agent 在协作中的实际贡献动态评估其
 * 重要性并据此调整协作拓扑。这里落地其「以历史贡献度量成员」的内核：
 * 每次编排结束后按子任务粒度累积成员的 通过/返工 表现（MemberStats），
 * 投影成路由信号 MemberPerformance 注入 RoutingCandidate.performance，
 * 让 leader 拆解/兜底指派时能参考成员的真实历史绩效。
 *
 * 数据流：编排 SubTaskResult → subtasksToOutcomes 归集 →
 * POST /api/member-stats/record → member-stats.json 持久化 →
 * GET /api/member-stats 快照 → projectRoutingCandidates 注入 performance。
 */

/** 单个成员的累计绩效（electron/utils/member-stats.ts 持久化记录）。 */
export interface MemberStats {
  /** 累计完成的子任务数（含未通过/失败）。 */
  tasks: number;
  /** 其中 leader 审阅通过（approved 且无 error）的子任务数。 */
  passed: number;
  /** 累计执行轮数（含返工轮；越高代表越费力）。 */
  totalRounds: number;
  /** 最近一次更新时间（ISO）。 */
  updatedAt: string;
}

/** 上报用：一条子任务的执行结果归集。 */
export interface MemberOutcome {
  agentId: string;
  /** 执行出错（error 非空）一律记 false。 */
  approved: boolean;
  rounds: number;
}

/**
 * 注入编排路由的绩效视图（RoutingCandidate.performance 契约字段）。
 * approvedRate ∈ [0,1]，avgRounds ≥ 0。
 */
export interface MemberPerformance {
  tasks: number;
  approvedRate: number;
  avgRounds: number;
}

/** GET /api/member-stats 与 POST /api/member-stats/record 的响应快照。 */
export interface MemberStatsSnapshot {
  stats: Record<string, MemberStats>;
}

/**
 * MemberStats → MemberPerformance 纯函数投影。
 * 边界：tasks=0（新成员）时 approvedRate 返回 1——没有历史就不罚，
 * 避免新成员因「零记录」被路由层系统性冷落（探索/利用权衡偏向探索）。
 */
export function toPerformance(stats: MemberStats | undefined | null): MemberPerformance {
  if (!stats || stats.tasks <= 0) {
    return { tasks: 0, approvedRate: 1, avgRounds: 0 };
  }
  return {
    tasks: stats.tasks,
    approvedRate: stats.passed / stats.tasks,
    avgRounds: stats.totalRounds / stats.tasks,
  };
}
