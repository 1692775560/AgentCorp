/**
 * src/engine/marketplace/matchScore.ts
 * 智能匹配排序引擎（模块 A）。
 *
 * 公式（严格照搬设计文档）：
 *
 *   effWeight = normalize( userWeight × dimBoost )
 *   userFit   = Σ_d (radar[d] / 5) × effWeight[d]
 *   tagMatch  = |tags(task) ∩ tags(cand)| / |tags(task) ∪ tags(cand)|   // 空集 → 0.5 中性
 *   costPerf  = clamp( (mean(radar)/5) / (budgetNum / budgetRef), 0, 1 ) // budgetRef = 列表最高报价
 *   perfBoost = s3Total != null ? s3Total / 100 : 0.5                    // 无绩效 → 0.5 中性
 *
 *   total = 100 × ( 0.50·userFit + 0.20·tagMatch + 0.15·costPerf + 0.15·perfBoost )
 *
 * 约定：**无六维的候选不参与 matchScore 计算**（返回 null），排序时沉底，
 * 卡片改为显示「S1 初审」按钮。
 *
 * 纯函数、无副作用、可单测。
 */
import type { JobType, RadarDim, RadarScore } from '@/types/evaluation';
import type { MatchScoreBreakdown, TaskProfile } from '@/types/marketplace';
import { applyTaskBoost, computeUserFit } from '@/engine/marketplace/userFit';
import { radarMean } from '@/engine/marketplace/radarSource';

/** 四项加权系数 */
export interface MatchWeights {
  fit: number;
  tag: number;
  cost: number;
  perf: number;
}

/** 默认四项权重：契合 0.5 / 标签 0.2 / 性价比 0.15 / 绩效 0.15 */
export const DEFAULT_MATCH_WEIGHTS: MatchWeights = {
  fit: 0.5,
  tag: 0.2,
  cost: 0.15,
  perf: 0.15,
};

/** 无绩效数据时的 perfBoost 中性值 */
export const NEUTRAL_PERF_BOOST = 0.5;

/** 标签集为空时的 tagMatch 中性值 */
export const NEUTRAL_TAG_MATCH = 0.5;

/** 参与匹配打分的候选最小输入（与 MarketCandidateView 兼容，便于单测构造） */
export interface MatchCandidateInput {
  /** 候选 id（templateId 或 agentId） */
  id: string;
  /** 候选能力标签 */
  tags: string[];
  /** 报价数值（元，0 = 免费） */
  budgetNum: number;
  /** 六维（0–5）；null → 不参与匹配计算 */
  radar: RadarScore | null;
  /** S3 绩效评分卡 total（0–100）；缺省 → perfBoost 取中性 0.5 */
  stageScoreTotal?: number | null;
  /** 候选工种（用于工种不符的软惩罚，可选） */
  jobType?: JobType | null;
}

/** 打分上下文 */
export interface MatchContext {
  /** 用户心智权重（scoringStore.userWeight） */
  userWeight: Partial<Record<RadarDim, number>>;
  /** 报价参照（当前列表最高报价），<=0 时性价比项取满分 */
  budgetRef: number;
  /** 四项权重（缺省用 DEFAULT_MATCH_WEIGHTS） */
  weights?: Partial<MatchWeights>;
  /** D · 老板原型强调系数（bossPersonaBoost）：使匹配按「与谁协作」个性化 */
  personaBoost?: Partial<Record<RadarDim, number>>;
}

/** 夹取到 [0,1] */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 标签归一（去空白、小写、去重），保证 Jaccard 对大小写与空格不敏感 */
function normalizeTagSet(tags: string[] | null | undefined): Set<string> {
  const set = new Set<string>();
  for (const tag of tags ?? []) {
    const t = String(tag).trim().toLowerCase();
    if (t) set.add(t);
  }
  return set;
}

/**
 * Jaccard 相似度：|A ∩ B| / |A ∪ B|。
 * 任一侧为空集（无需求标签 / 候选无标签）→ 返回 0.5 中性值，不惩罚也不奖励。
 */
export function jaccard(a: string[] | null | undefined, b: string[] | null | undefined): number {
  const setA = normalizeTagSet(a);
  const setB = normalizeTagSet(b);
  if (setA.size === 0 || setB.size === 0) return NEUTRAL_TAG_MATCH;

  let inter = 0;
  for (const item of setA) if (setB.has(item)) inter += 1;
  const union = setA.size + setB.size - inter;
  if (union <= 0) return NEUTRAL_TAG_MATCH;
  return clamp01(inter / union);
}

/**
 * 性价比归一：能力均值 / 相对报价。
 * - budgetRef <= 0（全部免费）→ 1（性价比拉满）；
 * - budgetNum <= 0（本候选免费）→ 1；
 * - 其余按 (mean/5) / (budgetNum/budgetRef) 夹取到 [0,1]。
 */
export function computeCostPerf(
  radar: RadarScore | null | undefined,
  budgetNum: number,
  budgetRef: number,
): number {
  if (!radar) return 0;
  const ability = clamp01(radarMean(radar) / 5);
  if (!Number.isFinite(budgetRef) || budgetRef <= 0) return ability > 0 ? 1 : 0;
  if (!Number.isFinite(budgetNum) || budgetNum <= 0) return 1;
  const relativeCost = budgetNum / budgetRef;
  if (relativeCost <= 0) return 1;
  return clamp01(ability / relativeCost);
}

/** 绩效回流项：S3 total/100；无绩效数据 → 0.5 中性 */
export function computePerfBoost(stageScoreTotal: number | null | undefined): number {
  if (typeof stageScoreTotal !== 'number' || !Number.isFinite(stageScoreTotal)) {
    return NEUTRAL_PERF_BOOST;
  }
  return clamp01(stageScoreTotal / 100);
}

/** 列表最高报价（budgetRef），空列表返回 0 */
export function budgetRefOf(candidates: Array<{ budgetNum: number }>): number {
  let max = 0;
  for (const c of candidates) {
    const b = Number.isFinite(c.budgetNum) ? c.budgetNum : 0;
    if (b > max) max = b;
  }
  return max;
}

/**
 * 匹配总分（主入口）。
 *
 * @returns 匹配分解；候选**无六维**时返回 null（不参与打分，排序沉底）。
 */
export function matchScore(
  candidate: MatchCandidateInput,
  taskProfile: TaskProfile | null | undefined,
  ctx: MatchContext,
): MatchScoreBreakdown | null {
  if (!candidate.radar) return null;

  const weights: MatchWeights = { ...DEFAULT_MATCH_WEIGHTS, ...(ctx.weights ?? {}) };

  // ① 六维契合（心智权重 × 任务强调 × 老板原型强调）
  const effWeight = applyTaskBoost(ctx.userWeight, taskProfile?.dimBoost, ctx.personaBoost);
  const userFit = computeUserFit(candidate.radar, effWeight);

  // ② 标签契合（Jaccard）
  const tagMatch = jaccard(taskProfile?.tags, candidate.tags);

  // ③ 性价比
  const costPerf = computeCostPerf(candidate.radar, candidate.budgetNum, ctx.budgetRef);

  // ④ 绩效回流（S3 → 市场
  const perfBoost = computePerfBoost(candidate.stageScoreTotal);

  const weightSum = weights.fit + weights.tag + weights.cost + weights.perf;
  const rawTotal =
    weights.fit * userFit +
    weights.tag * tagMatch +
    weights.cost * costPerf +
    weights.perf * perfBoost;
  // 权重和恒为 1（默认值），非默认权重时按权重和归一，保证 total ∈ [0,100]
  const normalized = weightSum > 0 ? rawTotal / weightSum : 0;

  return {
    total: Math.round(clamp01(normalized) * 100 * 10) / 10,
    userFit: Math.round(userFit * 1000) / 1000,
    tagMatch: Math.round(tagMatch * 1000) / 1000,
    costPerf: Math.round(costPerf * 1000) / 1000,
    perfBoost: Math.round(perfBoost * 1000) / 1000,
    weights: {
      fit: weights.fit,
      tag: weights.tag,
      cost: weights.cost,
      perf: weights.perf,
    },
    // D · 回声个性化强调系数（非空 = 本次匹配按老板原型个性化），供 UI 透明披露
    personaBoost:
      ctx.personaBoost && Object.keys(ctx.personaBoost).length > 0
        ? ctx.personaBoost
        : undefined,
  };
}

/**
 * 按匹配分降序排序（稳定）。
 * 无 match（= 无六维）的候选一律沉底，内部保持原有相对顺序。
 */
export function sortByMatch<T extends { match?: MatchScoreBreakdown | null }>(items: T[]): T[] {
  return [...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const sa = a.item.match?.total;
      const sb = b.item.match?.total;
      const hasA = typeof sa === 'number';
      const hasB = typeof sb === 'number';
      if (hasA && hasB && sa !== sb) return (sb as number) - (sa as number);
      if (hasA !== hasB) return hasA ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

export default matchScore;
