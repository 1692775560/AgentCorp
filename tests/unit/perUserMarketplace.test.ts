/**
 * tests/unit/perUserMarketplace.test.ts
 *
 * D · per-user FIT 市场推荐重构 单测。验证：
 *  - applyTaskBoost 在心智权重上叠加老板原型强调（personaBoost）后，
 *    被强调维的有效权重上升（Σ=1 不变）。
 *  - matchScore 在 personaBoost 下，对「强调维强」的候选给出更高 userFit / 总分；
 *    中性原型（无 personaBoost）时该差异消失（排序不受个性化干扰）。
 *
 * 纯引擎测试，不触达 store / 网络。运行：vitest run --pool=threads
 */
import { describe, it, expect } from 'vitest';
import type { RadarDim, RadarScore } from '@/types/evaluation';
import type { MatchScoreBreakdown, TaskProfile } from '@/types/marketplace';
import { applyTaskBoost } from '@/engine/marketplace/userFit';
import { matchScore } from '@/engine/marketplace/matchScore';
import { RADAR_DIMS } from '@/engine/scoring/registry';

/** 仅某一维为 strongVal、其余为 weakVal 的雷达 */
function radarWith(strongDim: RadarDim, strongVal = 5, weakVal = 1): RadarScore {
  const r: RadarScore = {
    task: weakVal,
    quality: weakVal,
    comm: weakVal,
    creativity: weakVal,
    reliability: weakVal,
    cost: weakVal,
  };
  r[strongDim] = strongVal;
  return r;
}

const DEFAULT_WEIGHT = {
  task: 0.2,
  quality: 0.2,
  comm: 0.15,
  creativity: 0.15,
  reliability: 0.15,
  cost: 0.15,
};

describe('D · applyTaskBoost 叠加老板原型强调', () => {
  it('叠加 reliability=1.5 后，reliability 有效权重上升且 Σ=1', () => {
    const w = applyTaskBoost(DEFAULT_WEIGHT, null, { reliability: 1.5 });
    expect(w.reliability).toBeGreaterThan(DEFAULT_WEIGHT.reliability);
    // 其余维被稀释（略降）
    expect(w.task).toBeLessThan(DEFAULT_WEIGHT.task);
    // 归一保证 Σ=1
    const sum = RADAR_DIMS.reduce((acc, d) => acc + w[d], 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('无 personaBoost → 权重等于仅心智权重（中性原型不改排序）', () => {
    const w = applyTaskBoost(DEFAULT_WEIGHT, null, null);
    for (const d of RADAR_DIMS) expect(w[d]).toBeCloseTo(DEFAULT_WEIGHT[d], 6);
  });
});

describe('D · matchScore 按老板原型个性化重排', () => {
  const taskProfile: TaskProfile | null = null;
  const ctx = { userWeight: DEFAULT_WEIGHT, budgetRef: 0 };

  it('中性原型：强调维强 vs 其他维强的候选 userFit 相等（不个性化）', () => {
    const a = matchScore(
      { id: 'A', tags: [], budgetNum: 0, radar: radarWith('reliability') },
      taskProfile,
      ctx,
    );
    const b = matchScore(
      { id: 'B', tags: [], budgetNum: 0, radar: radarWith('creativity') },
      taskProfile,
      ctx,
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect((a as MatchScoreBreakdown).userFit).toBeCloseTo((b as MatchScoreBreakdown).userFit, 6);
  });

  it('强调 reliability 的老板原型：reliability 强候选 userFit / 总分更高', () => {
    const personaCtx = { ...ctx, personaBoost: { reliability: 1.5 } };
    const a = matchScore(
      { id: 'A', tags: [], budgetNum: 0, radar: radarWith('reliability') },
      taskProfile,
      personaCtx,
    );
    const b = matchScore(
      { id: 'B', tags: [], budgetNum: 0, radar: radarWith('creativity') },
      taskProfile,
      personaCtx,
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect((a as MatchScoreBreakdown).userFit).toBeGreaterThan((b as MatchScoreBreakdown).userFit);
    expect((a as MatchScoreBreakdown).total).toBeGreaterThan((b as MatchScoreBreakdown).total);
    // 个性化强调系数回声到 breakdown，供 UI 透明披露
    expect((a as MatchScoreBreakdown).personaBoost).toEqual({ reliability: 1.5 });
  });

  it('中性原型 breakdown.personaBoost 为 undefined（未个性化）', () => {
    const a = matchScore(
      { id: 'A', tags: [], budgetNum: 0, radar: radarWith('reliability') },
      taskProfile,
      ctx,
    );
    expect((a as MatchScoreBreakdown).personaBoost).toBeUndefined();
  });
});
