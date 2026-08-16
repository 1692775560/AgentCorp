/**
 * src/engine/marketplace/paretoRank.ts
 * 二维 Pareto（质量 × 成本）非支配排序（模块 A ·  增量）。
 *
 * 智能匹配（matchScore）把多维压成一维总分，会丢失「质量高但贵」与「便宜但平庸」
 * 之间的真实权衡。Pareto 排序保留这种权衡：把候选分成「非支配前沿」，
 * 同一前沿内的候选互不可比（各有取舍），不同前沿则有明确的优劣。
 *
 * 坐标约定（越高越好，二者皆「越大越优」）：
 * - quality = radarMean（六维均值 0–5）
 * - cost    = radar.cost（0–5，越高 = 越省 = 越好）
 *
 * 支配定义：A 支配 B ⟺ A.quality ≥ B.quality 且 A.cost ≥ B.cost，且至少一项严格更大。
 *
 * 纯函数、无副作用、可单测。
 */
import type { MarketCandidateView } from '@/types/marketplace';
import { radarMean } from '@/engine/marketplace/radarSource';

/** 二维 Pareto 输入点 */
export interface ParetoPoint {
  /** 候选 id（用于回映到原候选） */
  id: string;
  /** 质量（越高越好） */
  quality: number;
  /** 成本友好度（越高越好，= radar.cost） */
  cost: number;
}

/** Pareto 排序结果 */
export interface ParetoRanked {
  /** 候选 id */
  id: string;
  /** 前沿层级：0 = 最优非支配前沿（其余依次为 1、2…） */
  front: number;
}

/** A 是否支配 B（二者皆越大越优） */
function dominates(a: ParetoPoint, b: ParetoPoint): boolean {
  return (
    a.quality >= b.quality &&
    a.cost >= b.cost &&
    (a.quality > b.quality || a.cost > b.cost)
  );
}

/**
 * 非支配排序（二维 Pareto）。
 * @returns 每个点的 front（0 = 最优前沿），顺序与输入一致。
 */
export function paretoRank(points: ParetoPoint[]): ParetoRanked[] {
  const n = points.length;
  if (n === 0) return [];

  // 每个点被多少个其他点支配
  const dominatedBy = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (dominates(points[i], points[j])) dominatedBy[j] += 1;
    }
  }

  const frontOf = new Array<number>(n).fill(-1);
  const assigned = new Set<number>();
  let currentFront = 0;

  while (assigned.size < n) {
    // 当前仅由已分配点支配、自身未被未分配点支配的点 → 进入本前沿
    const frontMembers: number[] = [];
    for (let i = 0; i < n; i++) {
      if (assigned.has(i)) continue;
      if (dominatedBy[i] === 0) frontMembers.push(i);
    }
    if (frontMembers.length === 0) break; // 安全兜底，避免死循环

    for (const i of frontMembers) {
      frontOf[i] = currentFront;
      assigned.add(i);
    }
    // 从剩余点的被支配计数中，减去本前沿成员对它们的支配
    for (const i of frontMembers) {
      for (let j = 0; j < n; j++) {
        if (assigned.has(j)) continue;
        if (dominates(points[i], points[j])) dominatedBy[j] -= 1;
      }
    }
    currentFront += 1;
  }

  return points.map((p, i) => ({ id: p.id, front: frontOf[i] }));
}

/**
 * 由市场候选视图构造 Pareto 点并排序。
 * 无六维的候选（radar 为 null）质量按 0 计，仍参与排序（沉底）。
 */
export function paretoRankCandidates(candidates: MarketCandidateView[]): ParetoRanked[] {
  const points: ParetoPoint[] = candidates.map((c) => ({
    id: c.id,
    quality: radarMean(c.radarResolution.radar),
    cost: c.radarResolution.radar?.cost ?? 0,
  }));
  return paretoRank(points);
}

export default paretoRank;
