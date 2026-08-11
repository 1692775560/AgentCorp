/**
 * src/engine/marketplace/userFit.ts
 * 用户契合度引擎（模块 A · 设计 §6 Step 2）。
 *
 * 镜像后端 `compute_user_fit` 公式（scoring 契约 §7.6）：
 *
 *   effWeight = normalize( userWeight[d] × (dimBoost[d] ?? 1) )     // Σ = 1
 *   userFit   = Σ_d (radar[d] / 5) × effWeight[d]                   // ∈ [0,1]
 *
 * `userWeight` 来自 `scoringStore.userWeight`（默认 DEFAULT_WEIGHT，绩效双榜拖拽
 * 回灌后更新）——这就是「绩效结果 → 市场匹配权重」闭环（设计 §7.3 通道 A）的执行点。
 *
 * 纯函数、无副作用、可单测：不读 store、不发网络。
 */
import type { RadarDim, RadarScore } from '@/types/evaluation';
import { RADAR_DIMS } from '@/engine/scoring/registry';

/** 六维权重向量（Σ=1） */
export type DimWeight = Record<RadarDim, number>;

/** 默认六维权重（与 scoringStore.DEFAULT_WEIGHT 同值，此处独立常量以保持引擎层零依赖 store） */
export const DEFAULT_DIM_WEIGHT: DimWeight = {
  task: 0.2,
  quality: 0.2,
  comm: 0.15,
  creativity: 0.15,
  reliability: 0.15,
  cost: 0.15,
};

/** 均匀权重（归一化兜底用） */
const UNIFORM_WEIGHT: DimWeight = {
  task: 1 / 6,
  quality: 1 / 6,
  comm: 1 / 6,
  creativity: 1 / 6,
  reliability: 1 / 6,
  cost: 1 / 6,
};

/**
 * 归一化权重向量，使 Σ = 1。
 * - 负数按 0 处理（权重不允许为负）；
 * - 全零 / 非法输入回退到均匀权重（避免除零产生 NaN 污染排序）。
 */
export function normalizeWeight(
  weight: Partial<Record<RadarDim, number>> | null | undefined,
): DimWeight {
  const raw: DimWeight = { ...UNIFORM_WEIGHT };
  let sum = 0;
  if (weight) {
    for (const dim of RADAR_DIMS) {
      const value = weight[dim];
      const safe = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
      raw[dim] = safe;
      sum += safe;
    }
  } else {
    return { ...UNIFORM_WEIGHT };
  }
  if (sum <= 0) return { ...UNIFORM_WEIGHT };

  const out = {} as DimWeight;
  for (const dim of RADAR_DIMS) out[dim] = raw[dim] / sum;
  return out;
}

/**
 * 心智权重 × 任务强调 × 老板原型强调 → 有效权重（Σ=1）。
 *
 * @param userWeight 用户心智权重（scoringStore.userWeight，允许未归一）
 * @param dimBoost   任务画像的维度强调系数（缺省视为 1）
 * @param personaBoost D · 老板原型强调系数（bossPersonaBoost，缺省视为 1）。
 *   使市场契合度按「与谁协作」个性化——同一候选对不同老板的匹配分不同
 *   （Wang 的个性化评估主张在推荐层的落地）。
 */
export function applyTaskBoost(
  userWeight: Partial<Record<RadarDim, number>> | null | undefined,
  dimBoost?: Partial<Record<RadarDim, number>> | null,
  personaBoost?: Partial<Record<RadarDim, number>> | null,
): DimWeight {
  const base = normalizeWeight(userWeight);
  let weight: DimWeight = base;

  // 任务强调、老板原型强调逐层相乘再归一（二者皆越大越优）
  for (const boost of [dimBoost, personaBoost]) {
    if (!boost) continue;
    const next: Partial<Record<RadarDim, number>> = {};
    for (const dim of RADAR_DIMS) {
      const factor = boost[dim];
      const safeFactor =
        typeof factor === 'number' && Number.isFinite(factor) && factor > 0 ? factor : 1;
      next[dim] = weight[dim] * safeFactor;
    }
    weight = normalizeWeight(next);
  }
  return weight;
}

/**
 * 六维加权契合度（0–1）。
 *
 * @param radar  候选六维（0–5）；null → 0（无数据不参与竞争）
 * @param weight 有效权重（建议先经 applyTaskBoost）；内部再做一次归一保证 Σ=1
 */
export function computeUserFit(
  radar: RadarScore | null | undefined,
  weight: Partial<Record<RadarDim, number>> | null | undefined,
): number {
  if (!radar) return 0;
  const w = normalizeWeight(weight);
  let fit = 0;
  for (const dim of RADAR_DIMS) {
    const score = typeof radar[dim] === 'number' && Number.isFinite(radar[dim]) ? radar[dim] : 0;
    fit += (Math.min(5, Math.max(0, score)) / 5) * w[dim];
  }
  return Math.min(1, Math.max(0, fit));
}

/**
 * 心智权重相对默认权重的偏移（正 = 用户更看重该维）。
 * 供 TaskRequirementBar 的「心智偏移指示」展示，证明绩效回灌确实生效。
 */
export function weightDeviation(
  userWeight: Partial<Record<RadarDim, number>> | null | undefined,
  baseline: DimWeight = DEFAULT_DIM_WEIGHT,
): Array<{ dim: RadarDim; delta: number }> {
  const w = normalizeWeight(userWeight);
  const b = normalizeWeight(baseline);
  return RADAR_DIMS.map((dim) => ({ dim, delta: w[dim] - b[dim] })).sort(
    (a, b2) => Math.abs(b2.delta) - Math.abs(a.delta),
  );
}
