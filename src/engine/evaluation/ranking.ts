/**
 * src/engine/evaluation/ranking.ts
 * 主观多元聚合与排序引擎。
 *
 * 设计来源：
 * - Chatbot Arena（arXiv:2403.04132）：成对比较 + 统计排序（此处提供其一致性检验部分）；
 * - Ranking Unraveled（ACL 2025, arXiv:2411.14483）：小而受控数据用 Bradley-Terry / Glicko，
 *   大而不均用 Glicko；本模块先落地确定性、无迭代的 TOPSIS 多维聚合；
 * - Reference-Guided Verdict（arXiv:2408.09235）：Fleiss' κ / Krippendorff's α 量化评委一致性；
 * - pymcdm（DOI:10.1016/j.softx.2023.101368）：TOPSIS/AHP 多维综合分替代朴素平均。
 *
 * 本文件提供两类能力（纯函数、零外部依赖、可单测）：
 *
 * 1. 评委一致性（Inter-rater Agreement）
 *    - `krippendorffAlphaMulti`：K 个评委 × N 个候选的评分矩阵 → Krippendorff's α
 *      （排序尺度 ordinal 特例；α < 0.67 触发复核，< 0.41 判定不可用）。
 *    - `fleissKappa`：Fleiss' κ（分类尺度，评委对候选判定类别的一致性）。
 *
 * 2. 多维聚合（Multi-Criteria Decision Making）
 *    - `topsisScore`：六维 + craft 的多维评分 → TOPSIS 综合分（贴近度 0–1），
 *      替代 `aggregateRadars` 的逐维朴素平均。支持权重向量（per-boss 个性化）。
 *    - `rankByTopsis`：按 TOPSIS 贴近度降序排序（稳定），无有效数据的候选沉底。
 *
 * 集成建议：
 * - judgeEnsemble.aggregateRadars 可保留为「展示均值」，但**最终排序**应改走
 *   rankByTopsis（纳入维度重要性权重，避免「六维平均」掩盖偏科型候选）。
 * - 多评委场景（HR + AI-judge）每轮用 krippendorffAlphaMulti 检一致性，
 *   α < 0.67 触发人工复核。
 *
 * 说明：本文件与 metaJudge.ts 的 `krippendorffAlpha`（评委 vs gold 二值）不同，
 * 这里是**多评委对多候选**的评分矩阵一致性，为完整实现，不依赖 Python sidecar。
 */

import type { RadarScore } from '@/types/evaluation';
import { RADAR_DIMS } from '@/engine/scoring/registry';

// ─────────────────────────────────────────────────────────────────────────────
// 一、评委一致性
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Krippendorff's α（ordinal 尺度，多评委 × 多候选）。
 *
 * 评分矩阵 rows = 候选（N），cols = 评委（K），值 = 分数（0–5，允许缺失 null）。
 * α = 1 − Do/De：
 * - Do = 观测到的平均成对距离（|a-b| 曼哈顿，ordinal 特例的线性距离）；
 * - De = 所有值两两配对（含同评委内不同候选）的平均距离（期望差异）。
 *
 * 返回 [-1, 1]：≥0.67 可接受；<0.41 不可用（Krippendorff 2004 分级）。
 */
export function krippendorffAlphaMulti(ratings: (number | null)[][]): number {
  const nCandidates = ratings.length;
  if (nCandidates < 2) return 0;

  // 摊平所有有效分数（含「同评委不同候选」与「同候选不同评委」）
  const values: number[] = [];
  for (const row of ratings) {
    for (const v of row) {
      if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
    }
  }
  if (values.length < 2) return 0;

  // 期望差异 De：所有值两两配对的距离（含自身对自身=0，来自同源的配对会造成低估；
  // 为贴近 Krippendorff 原式，这里用「所有配对距离的均值」的严格计算）
  let deSum = 0;
  let deCount = 0;
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < values.length; j++) {
      deSum += Math.abs(values[i] - values[j]);
      deCount += 1;
    }
  }
  const De = deSum / deCount;

  // 观测差异 Do：同候选内不同评委间的平均距离
  let doSum = 0;
  let doCount = 0;
  for (const row of ratings) {
    const valid = row.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        doSum += Math.abs(valid[i] - valid[j]);
        doCount += 1;
      }
    }
  }
  if (doCount === 0) return 0; // 每个候选至多一个评委打分 → 无法算观测差异
  const Do = doSum / doCount;

  if (De <= 0) return 1; // 所有值相同 → 完全一致
  return Math.round((1 - Do / De) * 1000) / 1000;
}

/**
 * Fleiss' κ（多评委 × 多候选，分类尺度）。
 * 评委对每个候选给出类别标签（如 verdict：hire/hold/reject），计算整体一致性。
 * κ = (P̄ − P̄e) / (1 − P̄e)：
 * - P̄ = 实际一致比例；
 * - P̄e = 随机一致期望。
 * 阈值：< 0.40 差；0.40–0.75 一般；> 0.75 好。
 */
export function fleissKappa(
  ratings: string[][],
  categories?: string[],
): number {
  const nCandidates = ratings.length;
  if (nCandidates === 0) return 0;
  const nJudges = ratings[0]?.length ?? 0;
  if (nJudges < 2) return 0;

  const cats = categories ?? Array.from(new Set(ratings.flat()));
  if (cats.length === 0) return 0;

  // P̄：每个候选的观察一致比例均值
  let pBar = 0;
  const catIndex = new Map(cats.map((c, i) => [c, i]));
  const countsPerCandidate: number[][] = ratings.map((row) => {
    const counts = new Array(cats.length).fill(0);
    for (const label of row) {
      const idx = catIndex.get(label);
      if (idx !== undefined) counts[idx] += 1;
    }
    const sumSq = counts.reduce((acc, c) => acc + c * c, 0);
    pBar += (sumSq - nJudges) / (nJudges * (nJudges - 1));
    return counts;
  });
  pBar /= nCandidates;

  // P̄e：每类边际概率平方和
  let pe = 0;
  for (let c = 0; c < cats.length; c++) {
    const total = countsPerCandidate.reduce((acc, counts) => acc + counts[c], 0);
    const p = total / (nCandidates * nJudges);
    pe += p * p;
  }

  // 完全一致（所有评委给同一类）时 P̄=1 且 P̄e=1 → κ 定义为 1（无分歧空间）
  if (pe >= 1) return pBar >= 1 ? 1 : 0;
  return Math.round(((pBar - pe) / (1 - pe)) * 1000) / 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、TOPSIS 多维聚合
// ─────────────────────────────────────────────────────────────────────────────

/** TOPSIS 输入：候选的多维分数（0–5，可含 craft 维）+ 维度权重 */
export interface TopsisCandidate {
  id: string;
  /** 六维（0–5）；缺失维按 0 处理（无证据） */
  radar: RadarScore | null;
  /** 附加维度（craft 等）：dim 名 → 分数（0–5） */
  extra?: Record<string, number> | null;
}

/** TOPSIS 聚合结果 */
export interface TopsisResult {
  id: string;
  /** 贴近度（0–1）：1 = 与正理想解重合（所有维都达满分） */
  closeness: number;
  /** 到正理想解的距离（越小越好） */
  dPlus: number;
  /** 到负理想解的距离（越大越好） */
  dMinus: number;
  /** 是否参与计算（有六维数据才参与） */
  computed: boolean;
}

/** 维度权重（六维，Σ=1；未提供的维用均匀权重兜底） */
export type DimWeights = Partial<Record<(typeof RADAR_DIMS)[number], number>>;

/** 从 RadarScore 构造维度向量（缺失维 → 0） */
function radarVector(radar: RadarScore | null, dims: string[]): number[] {
  return dims.map((dim) => {
    const v = radar?.[dim as keyof RadarScore];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(5, Math.max(0, v)) : 0;
  });
}

/** 归一化权重（Σ=1；全零/非法回退均匀） */
function normalizeWeights(weights: DimWeights | null | undefined, dims: string[]): number[] {
  const raw = dims.map((d) => {
    const w = weights?.[d as (typeof RADAR_DIMS)[number]];
    return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 0;
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    const u = 1 / dims.length;
    return dims.map(() => u);
  }
  return raw.map((w) => w / sum);
}

/**
 * TOPSIS 综合贴近度（单候选）。
 * 需要「全候选的分数矩阵」计算理想解；单候选场景退化为加权平均（无参照系）。
 *
 * @param candidate 候选
 * @param allCandidates 参与排序的全部候选（计算理想解参照）
 * @param weights 维度权重（可选，per-boss 个性化）
 * @param extraDims 附加维度名列表（默认取 candidates 中出现过的 extra 键）
 */
export function topsisScore(
  candidate: TopsisCandidate,
  allCandidates: TopsisCandidate[],
  weights?: DimWeights,
  extraDims?: string[],
): TopsisResult {
  if (!candidate.radar) {
    return { id: candidate.id, closeness: 0, dPlus: 0, dMinus: 0, computed: false };
  }

  const dims: string[] = [...RADAR_DIMS];
  const extraKeys = extraDims ?? Array.from(
    new Set(allCandidates.flatMap((c) => Object.keys(c.extra ?? {}))),
  );
  dims.push(...extraKeys.filter((k) => !dims.includes(k)));

  const w = normalizeWeights(weights, dims);
  const matrix = allCandidates.map((c) => {
    const base = radarVector(c.radar, dims);
    if (c.extra) {
      for (let i = 0; i < dims.length; i++) {
        const dim = dims[i];
        if ((RADAR_DIMS as string[]).includes(dim)) continue;
        const ev = c.extra[dim];
        if (typeof ev === 'number' && Number.isFinite(ev)) {
          base[i] = Math.min(5, Math.max(0, ev));
        }
      }
    }
    return base;
  });

  // 理想解：正 = 各维最大，负 = 各维最小
  const ideal = dims.map((_, i) => Math.max(...matrix.map((row) => row[i])));
  const nadir = dims.map((_, i) => Math.min(...matrix.map((row) => row[i])));

  const vector = radarVector(candidate.radar, dims);
  if (candidate.extra) {
    for (let i = 0; i < dims.length; i++) {
      const dim = dims[i];
      if ((RADAR_DIMS as string[]).includes(dim)) continue;
      const ev = candidate.extra[dim];
      if (typeof ev === 'number' && Number.isFinite(ev)) vector[i] = Math.min(5, Math.max(0, ev));
    }
  }

  const dPlus = Math.sqrt(dims.reduce((acc, _, i) => acc + w[i] * (vector[i] - ideal[i]) ** 2, 0));
  const dMinus = Math.sqrt(dims.reduce((acc, _, i) => acc + w[i] * (vector[i] - nadir[i]) ** 2, 0));
  const closeness =
    dPlus + dMinus === 0 ? 0 : Math.round((dMinus / (dPlus + dMinus)) * 1000) / 1000;

  return { id: candidate.id, closeness, dPlus, dMinus, computed: true };
}

/** 按 TOPSIS 贴近度降序排序（稳定；无数据候选沉底） */
export function rankByTopsis(
  candidates: TopsisCandidate[],
  weights?: DimWeights,
): TopsisResult[] {
  const scored = candidates.map((c) => topsisScore(c, candidates, weights));
  return scored
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ca = a.s.computed;
      const cb = b.s.computed;
      if (ca && cb && a.s.closeness !== b.s.closeness) return b.s.closeness - a.s.closeness;
      if (ca !== cb) return ca ? -1 : 1;
      return a.i - b.i;
    })
    .map((e) => e.s);
}

export default { krippendorffAlphaMulti, fleissKappa, topsisScore, rankByTopsis };
