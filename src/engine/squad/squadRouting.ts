/**
 * Squad Leader 路由决策（纯函数，无 store 耦合，可单测）。
 *
 * 决策对接层语义（creator 选定）：任务先给 leader，leader 依据成员画像
 * 决定「分给哪个成员」或「自己做」。信号全部来自真实数据：
 *   - Team.leaderId / Team.memberIds
 *   - 任务文本推断工种（inferJobType：image|text|code）
 *   - 各成员 EvaluationProfile（radarLatest 六维 + userFitLatest + jobType + lifecycle）
 *   - 成员在职状态（离职/淘汰不参与路由）
 *
 * 工种偏重维度（owner 决策，见 types/evaluation.ts §RadarScore 注释）：
 *   image → creativity；text → comm·quality；code → reliability·cost。
 *
 * 无匹配成员 / 均离线 / 最优分低于阈值 → leader 自留。
 */
import type { JobType, RadarScore } from "../../types/evaluation";
import { inferJobType } from "../marketplace/taskMatch";

/** 参与路由的最简成员画像视图（由调用方从 store 投影，避免耦合）。 */
export interface RoutingCandidate {
  agentId: string;
  /** 是否在职（RETIRED/淘汰应传 false，将被排除出路由候选） */
  active: boolean;
  /** 该成员的擅长工种（EvaluationProfile.jobType），缺失表示未评估 */
  jobType?: JobType | null;
  /** 六维雷达（EvaluationProfile.radarLatest），缺失按 0 处理 */
  radar?: RadarScore | null;
  /** 用户契合度 0–100（EvaluationProfile.userFitLatest），缺失回退 radar.task*20 */
  userFit?: number | null;
}

export interface SquadRoutingInput {
  /** 任务标题 + 描述拼接文本，用于推断工种 */
  taskText: string | null | undefined;
  /** 团队 leader 的 agentId；缺失表示团队没有 leader */
  leaderId: string | null | undefined;
  /** 候选成员画像（通常为 team.memberIds 投影，可含或不含 leader） */
  candidates: RoutingCandidate[];
}

export interface SquadRoutingDecision {
  /** 最终被指派的 agentId（成员或 leader） */
  assigneeId: string;
  /** 是否为 leader 自留 */
  leaderKept: boolean;
  /** 推断出的任务工种（null 表示无法判定） */
  jobType: JobType | null;
  /** 命中成员的匹配分（0–100，leader 自留时为 0） */
  score: number;
  /** 人类可读的决策理由（写入 execution 事件流） */
  reason: string;
}

/** 最优成员分数低于此阈值时，leader 选择自留。 */
export const MIN_ROUTE_SCORE = 20;

const ZERO_RADAR: RadarScore = {
  task: 0,
  quality: 0,
  comm: 0,
  creativity: 0,
  reliability: 0,
  cost: 0,
};

/** 工种 → 偏重维度权重（其余维度以基础权重参与，保证有区分度）。 */
function jobWeights(job: JobType | null): RadarScore {
  const base: RadarScore = {
    task: 1,
    quality: 1,
    comm: 1,
    creativity: 1,
    reliability: 1,
    cost: 1,
  };
  if (job === "image") return { ...base, creativity: 3 };
  if (job === "text") return { ...base, comm: 3, quality: 3 };
  if (job === "code") return { ...base, reliability: 3, cost: 3 };
  return base;
}

/** 加权雷达得分归一到 0–100。 */
function radarScore(radar: RadarScore, w: RadarScore): number {
  // 每维 0–5，权重和 * 5 为满分
  const raw =
    radar.task * w.task +
    radar.quality * w.quality +
    radar.comm * w.comm +
    radar.creativity * w.creativity +
    radar.reliability * w.reliability +
    radar.cost * w.cost;
  const max = (w.task + w.quality + w.comm + w.creativity + w.reliability + w.cost) * 5;
  return max > 0 ? (raw / max) * 100 : 0;
}

function candidateUserFit(c: RoutingCandidate): number {
  if (typeof c.userFit === "number") return Math.max(0, Math.min(100, c.userFit));
  const radar = c.radar ?? ZERO_RADAR;
  return Math.max(0, Math.min(100, radar.task * 20)); // Leaderboard 一致的回退口径
}

/** 单个成员对某工种任务的综合匹配分（0–100）。 */
function scoreCandidate(c: RoutingCandidate, job: JobType | null): number {
  const radar = c.radar ?? ZERO_RADAR;
  const rScore = radarScore(radar, jobWeights(job));
  const fit = candidateUserFit(c);
  // 工种对口加成：成员声明工种与任务工种一致时 +15（封顶 100）
  const jobBonus = job && c.jobType === job ? 15 : 0;
  return Math.min(100, Math.round(rScore * 0.6 + fit * 0.4 + jobBonus));
}

/**
 * Leader 路由决策主入口。
 * 返回被指派的 agent + 可解释理由。任何异常输入都安全回退到 leader 自留。
 */
export function routeBySquadLeader(input: SquadRoutingInput): SquadRoutingDecision {
  const job = inferJobType(input.taskText);
  const leaderId = input.leaderId ?? null;

  // 排除 leader 自身与离职成员，得到可路由候选
  const routable = input.candidates.filter(
    (c) => c.active && c.agentId !== leaderId,
  );

  if (routable.length === 0) {
    return {
      assigneeId: leaderId ?? "",
      leaderKept: true,
      jobType: job,
      score: 0,
      reason: leaderId
        ? "无在职成员可路由，leader 自留处理。"
        : "团队无 leader 且无可路由成员。",
    };
  }

  // 打分并取最优（同分优先工种对口者，其次 userFit 高者）
  const ranked = routable
    .map((c) => ({ c, s: scoreCandidate(c, job) }))
    .sort((a, b) => {
      if (b.s !== a.s) return b.s - a.s;
      const aFit = candidateUserFit(a.c);
      const bFit = candidateUserFit(b.c);
      return bFit - aFit;
    });

  const best = ranked[0];

  if (best.s < MIN_ROUTE_SCORE) {
    return {
      assigneeId: leaderId ?? best.c.agentId,
      leaderKept: Boolean(leaderId),
      jobType: job,
      score: best.s,
      reason: leaderId
        ? `候选成员匹配分均低于 ${MIN_ROUTE_SCORE}（最高 ${best.s}），leader 自留。`
        : `无 leader，指派最高分成员 ${best.c.agentId}（${best.s}）。`,
    };
  }

  const jobLabel = job ?? "通用";
  return {
    assigneeId: best.c.agentId,
    leaderKept: false,
    jobType: job,
    score: best.s,
    reason: `工种[${jobLabel}] leader 路由 → 成员 ${best.c.agentId}（匹配分 ${best.s}${
      job && best.c.jobType === job ? "，工种对口" : ""
    }）。`,
  };
}
