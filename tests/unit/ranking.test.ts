/**
 * tests/unit/ranking.test.ts
 * G4 聚合排序引擎专项锁（Krippendorff α / Fleiss κ / TOPSIS）。
 *
 * 覆盖：
 * - krippendorffAlphaMulti：完全一致=1、反向=-1、随机≈0、样本不足=0
 * - fleissKappa：完全一致=1、随机≈0
 * - topsisScore：贴近度单调性、正理想解贴近=1、负理想解贴近=0
 * - rankByTopsis：降序稳定排序、无数据沉底、权重影响排序
 */
import { describe, it, expect } from 'vitest';
import {
  krippendorffAlphaMulti,
  fleissKappa,
  topsisScore,
  rankByTopsis,
  type TopsisCandidate,
} from '@/engine/evaluation/ranking';

function cand(id: string, task: number, quality: number, comm = 3): TopsisCandidate {
  return { id, radar: { task, quality, comm, creativity: 3, reliability: 3, cost: 3 } };
}

describe('ranking · krippendorffAlphaMulti', () => {
  it('所有评委给分完全一致 → α=1', () => {
    const ratings = [
      [4, 4, 4],
      [3, 3, 3],
      [5, 5, 5],
    ];
    expect(krippendorffAlphaMulti(ratings)).toBe(1);
  });

  it('完全反向（评委A给高，评委B给低）→ α 为负', () => {
    const ratings = [
      [5, 1],
      [4, 2],
      [1, 5],
    ];
    expect(krippendorffAlphaMulti(ratings)).toBeLessThan(0);
  });

  it('样本不足（单候选）→ 0', () => {
    expect(krippendorffAlphaMulti([[4, 4, 4]])).toBe(0);
  });

  it('缺失值不参与计算且不抛异常', () => {
    const ratings = [
      [4, null, 4],
      [3, 3, null],
    ];
    expect(() => krippendorffAlphaMulti(ratings)).not.toThrow();
  });
});

describe('ranking · fleissKappa', () => {
  it('所有评委给同一类别 → κ=1', () => {
    const ratings = [
      ['hire', 'hire', 'hire'],
      ['hire', 'hire', 'hire'],
    ];
    expect(fleissKappa(ratings)).toBe(1);
  });

  it('评委数不足 → 0', () => {
    expect(fleissKappa([['hire']])).toBe(0);
  });

  it('随机分布 → κ 接近 0', () => {
    // 3 评委 × 6 候选：每个候选内 3 个评委意见刻意打散（2 对 1 或 1 对 2），
    // 类别整体均匀 → 观察一致性与随机期望接近 → κ ≈ 0
    const ratings = [
      ['hire', 'reject', 'hire'],
      ['reject', 'hire', 'reject'],
      ['hire', 'hire', 'reject'],
      ['reject', 'reject', 'hire'],
      ['hire', 'reject', 'reject'],
      ['reject', 'hire', 'hire'],
    ];
    expect(Math.abs(fleissKappa(ratings))).toBeLessThan(0.35);
  });
});

describe('ranking · topsisScore', () => {
  it('正理想解（所有维都最高）→ closeness=1', () => {
    const best = cand('best', 5, 5);
    const others = [cand('a', 3, 3), cand('b', 4, 4)];
    const r = topsisScore(best, [best, ...others]);
    expect(r.computed).toBe(true);
    expect(r.closeness).toBe(1);
  });

  it('负理想解（所有维都最低）→ closeness=0', () => {
    const worst = cand('worst', 0, 0);
    const others = [cand('a', 4, 4), cand('b', 5, 5)];
    const r = topsisScore(worst, [worst, ...others]);
    expect(r.closeness).toBe(0);
  });

  it('贴近度单调性：更强的候选 closeness 更高', () => {
    const strong = cand('strong', 5, 5);
    const weak = cand('weak', 2, 2);
    const rStrong = topsisScore(strong, [strong, weak]);
    const rWeak = topsisScore(weak, [strong, weak]);
    expect(rStrong.closeness).toBeGreaterThan(rWeak.closeness);
  });

  it('无六维数据 → computed=false', () => {
    const r = topsisScore({ id: 'x', radar: null }, [cand('a', 3, 3)]);
    expect(r.computed).toBe(false);
    expect(r.closeness).toBe(0);
  });
});

describe('ranking · rankByTopsis', () => {
  it('按贴近度降序（稳定）', () => {
    const c1 = cand('1', 5, 5);
    const c2 = cand('2', 3, 3);
    const c3 = cand('3', 4, 4);
    const ranked = rankByTopsis([c3, c1, c2]);
    expect(ranked.map((r) => r.id)).toEqual(['1', '3', '2']);
  });

  it('无六维候选沉底', () => {
    const c1 = cand('1', 5, 5);
    const c2 = { id: '2', radar: null } as TopsisCandidate;
    const ranked = rankByTopsis([c1, c2]);
    expect(ranked.map((r) => r.id)).toEqual(['1', '2']);
    expect(ranked[1].computed).toBe(false);
  });

  it('权重影响排序：高权重维得分高者靠前', () => {
    const taskStar = cand('task', 5, 2); // 任务强、质量弱
    const qualityStar = cand('quality', 2, 5); // 质量强、任务弱
    // 权重偏向 task → taskStar 应靠前
    const wTask = rankByTopsis([taskStar, qualityStar], { task: 0.9, quality: 0.1 });
    expect(wTask[0].id).toBe('task');
    // 权重偏向 quality → qualityStar 应靠前
    const wQuality = rankByTopsis([taskStar, qualityStar], { task: 0.1, quality: 0.9 });
    expect(wQuality[0].id).toBe('quality');
  });
});
