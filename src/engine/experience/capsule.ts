/**
 * src/engine/experience/capsule.ts
 * 经验胶囊的纯函数层：构建 + 检索。
 *
 * 设计理念（借鉴 EvoX Evolver 的 Capsule + AgentCorp 评测视角）：
 * 把一次「用人 → 真实交付 → 评测回流」的完整协作，沉淀为一颗可复用胶囊。
 * 胶囊既是 G12 eval-in-loop 的回归集原子，也是后续 Agent 适配与群体经验
 * 共享的基础——兑现 AgentCorp 北极星「人的能力增量」（前后胶囊对比即增量）。
 *
 * 纯函数、无副作用、可单测。落盘由 capsule-store（主进程）负责；
 * 渲染层经 Host API 读写，与 trace 浏览同模式。
 */
import type {
  ExperienceCapsule,
  CapsuleQuery,
} from '@/types/capsule';
import type {
  EvaluationProfile,
  JobType,
  RadarScore,
} from '@/types/evaluation';

/**
 * 构建胶囊所需的最小工作输入（CompletedWork 的结构子集）。
 * 本地定义而非 import CompletedWork，避免 engine → services 的类型依赖
 * 在 node tsconfig 下触发 TS6307（include 范围）。CompletedWork 是其超集，
 * 调用方直接传 CompletedWork 即可（TS 结构类型兼容）。
 */
export interface CapsuleWorkInput {
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  agentId: string;
  agentName: string;
  output: string;
  runId?: string | null;
  sessionId?: string | null;
  sessionKey?: string | null;
  reworkRounds?: number;
  approved?: boolean | null;
}

/** 交付物摘要长度上限（控制体积与隐私面） */
const OUTPUT_DIGEST_CHARS = 200;
/** 任务描述摘要长度上限 */
const TASK_DESC_DIGEST_CHARS = 120;

/** 生成胶囊 ID：时间戳 + 随机后缀，不依赖 uuid 库。 */
function generateCapsuleId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `cap-${Date.now()}-${rand}`;
}

/** 由 approved 派生人的判断三态。 */
function deriveHumanJudgment(
  approved: boolean | null | undefined,
): 'approved' | 'rejected' | 'neutral' {
  if (approved === true) return 'approved';
  if (approved === false) return 'rejected';
  return 'neutral';
}

/**
 * 把一次完成的工作 + 评测档案组装成经验胶囊（纯函数）。
 *
 * 纪律：
 * - profile 缺失时仍可构建胶囊（radar=null），但调用方应优先在评测成功后调用；
 * - 不存交付物全文，只存摘要（前 200 字）+ 长度；
 * - 不编造任何字段，缺失即 null/undefined。
 */
export function buildCapsule(
  work: CapsuleWorkInput,
  profile: EvaluationProfile | null | undefined,
): ExperienceCapsule {
  const output = (work.output ?? '').trim();
  const desc = (work.taskDescription ?? '').trim();
  const radar: RadarScore | null = profile?.radarLatest ?? null;
  const jobType: JobType | null | undefined = profile?.jobType ?? null;

  return {
    capsuleId: generateCapsuleId(),
    createdAt: new Date().toISOString(),
    taskId: work.taskId,
    taskTitle: work.taskTitle,
    taskDescriptionDigest: desc
      ? desc.slice(0, TASK_DESC_DIGEST_CHARS)
      : null,
    agentId: work.agentId,
    agentName: work.agentName,
    jobType: jobType ?? null,
    radar,
    userFit: profile?.userFitLatest ?? null,
    reworkRounds: work.reworkRounds ?? 0,
    approved: work.approved ?? null,
    outputLength: output.length,
    outputDigest: output.slice(0, OUTPUT_DIGEST_CHARS),
    runId: work.runId ?? null,
    sessionId: work.sessionId ?? null,
    humanJudgment: deriveHumanJudgment(work.approved),
    rootSessionId: work.sessionKey ?? null,
    schemaVersion: 1,
  };
}

/**
 * 按条件检索相似胶囊（纯函数，基于已加载列表）。
 *
 * 匹配规则（按优先级降序）：
 * 1. jobType 相同（工种对口是强信号）；
 * 2. agentId 相同（同一 Agent 的历史交付是直接经验）；
 * 3. approved === true 优先（成功交付比返工更有参考价值）。
 *
 * 简单过滤 + 排序，不做向量相似度（那是深水区，留给后续 LLM 抽取）。
 */
export function findSimilarCapsules(
  capsules: ExperienceCapsule[],
  query: CapsuleQuery,
): ExperienceCapsule[] {
  const limit = query.limit && query.limit > 0 ? query.limit : 20;
  const filtered = capsules.filter((c) => {
    if (query.jobType != null && c.jobType !== query.jobType) return false;
    if (query.agentId && c.agentId !== query.agentId) return false;
    if (query.approved != null && (c.approved ?? null) !== query.approved) {
      return false;
    }
    return true;
  });

  // 排序：agentId 命中 > jobType 命中 > approved > 时间倒序
  const scored = filtered.map((c) => {
    let score = 0;
    if (query.agentId && c.agentId === query.agentId) score += 4;
    if (query.jobType != null && c.jobType === query.jobType) score += 2;
    if (c.approved === true) score += 1;
    return { c, score };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.c.createdAt ?? '').localeCompare(a.c.createdAt ?? '');
  });
  return scored.slice(0, limit).map((s) => s.c);
}

/**
 * 计算某 agent 在某工种上的历史表现摘要（纯函数）。
 * 供 matchScore 的 perfBoost 维度消费：用真实交付替代中性 0.5 兜底。
 *
 * 返回 null 表示无历史样本（调用方保持原中性兜底，不编造）。
 */
export function summarizeAgentPerformance(
  capsules: ExperienceCapsule[],
  agentId: string,
  jobType?: JobType | null,
): {
  sampleSize: number;
  approvalRate: number;
  avgRework: number;
  avgUserFit: number | null;
} | null {
  const matching = capsules.filter(
    (c) =>
      c.agentId === agentId &&
      (jobType == null || c.jobType === jobType),
  );
  if (matching.length === 0) return null;
  const approved = matching.filter((c) => c.approved === true).length;
  const reworkSum = matching.reduce(
    (sum, c) => sum + (c.reworkRounds ?? 0),
    0,
  );
  const fitCapsules = matching.filter(
    (c) => typeof c.userFit === 'number',
  );
  const fitSum = fitCapsules.reduce(
    (sum, c) => sum + (c.userFit ?? 0),
    0,
  );
  return {
    sampleSize: matching.length,
    approvalRate: approved / matching.length,
    avgRework: reworkSum / matching.length,
    avgUserFit:
      fitCapsules.length > 0 ? fitSum / fitCapsules.length : null,
  };
}
