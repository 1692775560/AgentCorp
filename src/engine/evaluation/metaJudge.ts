/**
 * src/engine/evaluation/metaJudge.ts
 * 评委元评估引擎。
 *
 * 设计来源：
 * - JudgeBench（arXiv:2410.12784）：用「客观正确性子集」检验 LLM 评委是否与事实/人类一致，
 *   发现 GPT-4o 类评委在事实/逻辑正确性上仅略高于随机——评委本身需要被监管。
 * - CALM（arXiv:2410.02736）：一致性率 CR、鲁棒性率 RR 作为评委偏差的量化指标。
 * - ：新增 metaJudge 定期用客观正确性子集检验评委，监控评委漂移。
 *
 * 本模块回答三个问题（对应三种诊断粒度）：
 * 1. 这个评委总体上准不准？      → 与基准答案（gold）的一致性（accuracy / Krippendorff α）
 * 2. 这个评委最近有没有漂移？    → 滑动窗口上一致性趋势（旧窗口 vs 新窗口）
 * 3. 这个评委在哪些维度/题型上弱？→ 按维度分组的逐维一致性
 *
 * 设计约束（对齐项目架构铁律）：
 * - 纯函数、无副作用、无外部依赖，可直接单测；
 * - 不调用任何 LLM——输入是「评委输出 vs 基准答案」的已收集样本；
 * - 判定阈值全部可配置，默认值有文献依据（α ≥ 0.67 视为可接受，< 0.41 视为不可用，
 *   取自 Krippendorff 2004 的既有信度分级）。
 *
 * 用法（建议接入点）：
 * - 评估中心每次产终评后，把「评委输出 vs 人工复核」样本喂给 metaJudge.assess；
 * - 周期性（如每 50 个样本）调用 driftCheck 看评委是否漂移；
 * - 阈值不达标时，UI 应提示「评委需校准/更换」，并把该评委标记为低置信。
 */

/** 单条元评估样本：一个客观正确性基准题（gold），评委给出的判断。 */
export interface MetaJudgeSample {
  /** 样本 id（去重/审计用） */
  id: string;
  /** 被检验的评委模型标识（如 'minicpm-o-4.5' / 'gpt-4o'） */
  judgeId: string;
  /** 客观正确性基准（gold 标准）——由人工或事实校验给出 */
  gold: boolean;
  /** 评委对该题给出的判断（正确 / 不正确） */
  judgeVerdict: boolean;
  /** 评委给出的置信度（0–1，可选，用于置信校准分析） */
  confidence?: number | null;
  /** 题型/维度标签（如 'factuality' | 'logic' | 'quality'），用于逐维诊断 */
  dim?: string | null;
  /** 采样时间戳（ISO8601，漂移检测用） */
  ts?: string | null;
}

/** 二值一致性分类结果 */
export interface BinaryAgreement {
  /** 样本数 */
  n: number;
  /** 一致数（评委判断 == gold） */
  agree: number;
  /** 一致率（accuracy，0–1） */
  accuracy: number;
}

/** 按维度分组的诊断 */
export interface DimDiagnosis {
  dim: string;
  n: number;
  accuracy: number;
  /** 该维是否达到可接受阈值（默认 0.67） */
  acceptable: boolean;
}

/**
 * 评委元评估结果。
 * 综合三种诊断：总体一致性 / 漂移 / 逐维薄弱点。
 */
export interface MetaJudgeReport {
  judgeId: string;
  /** 样本量 */
  sampleCount: number;
  /** 总体一致率（accuracy） */
  accuracy: number;
  /** 评估窗口（默认 0.67）内是否「总体可信」 */
  overallAcceptable: boolean;
  /** 漂移检测结果（样本足够时才有意义） */
  drift: {
    /** 旧窗口（更早 50% 样本）一致率 */
    earlyAccuracy: number;
    /** 新窗口（更近 50% 样本）一致率 */
    recentAccuracy: number;
    /** 漂移量 = recentAccuracy − earlyAccuracy（负 = 变差） */
    delta: number;
    /** 是否判定为「漂移」（|delta| 超过阈值且样本足够） */
    drifted: boolean;
    /** 漂移方向（'improved' | 'degraded' | 'stable' | 'insufficient'） */
    direction: 'improved' | 'degraded' | 'stable' | 'insufficient';
  };
  /** 逐维诊断（样本带 dim 时才生成） */
  byDim: DimDiagnosis[];
  /** 最弱维度（accuracy 最低，可接受性为 false 时优先提示校准） */
  weakestDim: DimDiagnosis | null;
  /** 平均置信度（样本带 confidence 时）——用于置信校准检查 */
  avgConfidence: number | null;
  /** 置信校准缺口 = |avgConfidence − accuracy|（越接近 0 越好；差距大说明评委过度自信） */
  calibrationGap: number | null;
}

/** 元评估选项 */
export interface MetaJudgeOptions {
  /** 总体可信阈值（Krippendorff α 分级：0.67 为可接受下限） */
  acceptableThreshold?: number;
  /** 漂移判定阈值（|delta| 超过此值视为漂移） */
  driftThreshold?: number;
  /** 漂移检测所需最少样本数（不足则 direction='insufficient'） */
  minSamplesForDrift?: number;
}

/** 默认阈值（文献依据） */
export const META_JUDGE_DEFAULTS = {
  /** α ≥ 0.67：可接受（Krippendorff 2004） */
  acceptableThreshold: 0.67,
  /** 漂移判定：窗口间一致率变化超 0.15 视为显著 */
  driftThreshold: 0.15,
  /** 至少 20 个样本才做漂移检测（统计意义下限） */
  minSamplesForDrift: 20,
} as const;

/** 按时间戳排序（升序）；无时间戳的样本排在最后并保持原序 */
function sortByTs<T extends { ts?: string | null }>(samples: T[]): T[] {
  return [...samples].sort((a, b) => {
    const ta = a.ts ? Date.parse(a.ts) : Number.POSITIVE_INFINITY;
    const tb = b.ts ? Date.parse(b.ts) : Number.POSITIVE_INFINITY;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb;
  });
}

/** 计算一致率（纯函数） */
export function agreement(samples: Pick<MetaJudgeSample, 'gold' | 'judgeVerdict'>[]): BinaryAgreement {
  const n = samples.length;
  let agree = 0;
  for (const s of samples) {
    if (s.gold === s.judgeVerdict) agree += 1;
  }
  return { n, agree, accuracy: n === 0 ? 0 : Math.round((agree / n) * 1000) / 1000 };
}

/**
 * 二值数据的 Krippendorff's α（等价于 Cohen's κ 的 α 特例，无 rater 维度差异）。
 * 这里用于「评委判断 vs gold 标准」的一致性：α = 1 − Do/De。
 * - Do = 观测不一致比例；De = 期望不一致比例（边际随机）。
 * - 返回 -1..1；α ≥ 0.67 可接受，α < 0.41 不可用（Krippendorff 分级）。
 * 纯函数实现，不引 Python sidecar。
 */
export function krippendorffAlpha(
  samples: Pick<MetaJudgeSample, 'gold' | 'judgeVerdict'>[],
): number {
  const n = samples.length;
  if (n < 2) return 0;
  // 2×2 列联表：gold \ judgeVerdict
  let a11 = 0; // gold=true, judge=true
  let a12 = 0; // gold=true, judge=false
  let a21 = 0; // gold=false, judge=true
  let a22 = 0; // gold=false, judge=false
  for (const s of samples) {
    if (s.gold) {
      if (s.judgeVerdict) a11 += 1;
      else a12 += 1;
    } else {
      if (s.judgeVerdict) a21 += 1;
      else a22 += 1;
    }
  }
  // 观测不一致比例 Do
  const disagree = a12 + a21;
  const Do = disagree / n;
  // 期望不一致比例 De（基于边际独立的随机一致率）
  const goldTrue = a11 + a12;
  const judgeTrue = a11 + a21;
  // 随机期望一致率 Pe = P(gold=t)·P(judge=t) + P(gold=f)·P(judge=f)
  const Pe = (goldTrue / n) * (judgeTrue / n) + ((n - goldTrue) / n) * ((n - judgeTrue) / n);
  const De = 1 - Pe;
  if (De <= 0) return 1; // 边际完全确定，无分歧空间 → 视为完全一致
  return Math.round((1 - Do / De) * 1000) / 1000;
}

/** 按维度分组诊断（纯函数） */
export function diagnoseByDim(samples: MetaJudgeSample[]): DimDiagnosis[] {
  const groups = new Map<string, MetaJudgeSample[]>();
  for (const s of samples) {
    const dim = s.dim ?? 'unspecified';
    if (!groups.has(dim)) groups.set(dim, []);
    groups.get(dim)!.push(s);
  }
  const out: DimDiagnosis[] = [];
  for (const [dim, group] of groups) {
    const acc = agreement(group).accuracy;
    out.push({
      dim,
      n: group.length,
      accuracy: acc,
      acceptable: acc >= META_JUDGE_DEFAULTS.acceptableThreshold,
    });
  }
  // 按 accuracy 升序（最弱在前），同值按 n 降序（样本多的优先）
  out.sort((a, b) => a.accuracy - b.accuracy || b.n - a.n);
  return out;
}

/**
 * 漂移检测（纯函数）：
 * 按时间戳排序后把样本平分为 early/recent 两半，比较两半一致率。
 */
export function driftCheck(
  samples: MetaJudgeSample[],
  opts?: { driftThreshold?: number; minSamplesForDrift?: number },
): MetaJudgeReport['drift'] {
  const driftThreshold = opts?.driftThreshold ?? META_JUDGE_DEFAULTS.driftThreshold;
  const minSamples = opts?.minSamplesForDrift ?? META_JUDGE_DEFAULTS.minSamplesForDrift;
  const sorted = sortByTs(samples);
  if (sorted.length < minSamples) {
    return {
      earlyAccuracy: 0,
      recentAccuracy: 0,
      delta: 0,
      drifted: false,
      direction: 'insufficient',
    };
  }
  const half = Math.floor(sorted.length / 2);
  const early = sorted.slice(0, half);
  const recent = sorted.slice(half);
  const earlyAcc = agreement(early).accuracy;
  const recentAcc = agreement(recent).accuracy;
  const delta = Math.round((recentAcc - earlyAcc) * 1000) / 1000;
  const absDelta = Math.abs(delta);
  const drifted = absDelta >= driftThreshold;
  const direction: MetaJudgeReport['drift']['direction'] =
    !drifted ? 'stable' : delta > 0 ? 'improved' : 'degraded';
  return { earlyAccuracy: earlyAcc, recentAccuracy: recentAcc, delta, drifted, direction };
}

/**
 * 元评估主入口：综合总体一致性、漂移、逐维诊断、置信校准。
 * 纯函数、无副作用。
 */
export function assessMetaJudge(
  samples: MetaJudgeSample[],
  opts?: MetaJudgeOptions,
): MetaJudgeReport {
  const acceptableThreshold =
    opts?.acceptableThreshold ?? META_JUDGE_DEFAULTS.acceptableThreshold;
  const judgeId = samples[0]?.judgeId ?? 'unknown';

  const agg = agreement(samples);
  const byDim = diagnoseByDim(samples);
  const drift = driftCheck(samples, {
    driftThreshold: opts?.driftThreshold,
    minSamplesForDrift: opts?.minSamplesForDrift,
  });

  // 置信校准：平均置信 vs 一致率
  const confidences = samples
    .map((s) => s.confidence)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  const avgConfidence = confidences.length
    ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 1000) / 1000
    : null;
  const calibrationGap =
    avgConfidence !== null ? Math.round(Math.abs(avgConfidence - agg.accuracy) * 1000) / 1000 : null;

  const weakestDim = byDim.length > 0 ? byDim[0] : null;

  return {
    judgeId,
    sampleCount: agg.n,
    accuracy: agg.accuracy,
    overallAcceptable: agg.accuracy >= acceptableThreshold,
    drift,
    byDim,
    weakestDim,
    avgConfidence,
    calibrationGap,
  };
}

export default assessMetaJudge;
