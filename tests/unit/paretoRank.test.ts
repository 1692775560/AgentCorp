import { describe, it, expect } from 'vitest';
import {
  paretoRank,
  paretoRankCandidates,
  type ParetoPoint,
} from '@/engine/marketplace/paretoRank';

describe('paretoRank', () => {
  it('front 0 包含非支配点，被支配者层级递增', () => {
    const points: ParetoPoint[] = [
      { id: 'a', quality: 5, cost: 5 }, // 支配其余
      { id: 'b', quality: 3, cost: 3 },
      { id: 'c', quality: 1, cost: 1 },
    ];
    const ranked = paretoRank(points);
    const frontOf = Object.fromEntries(ranked.map((r) => [r.id, r.front]));
    expect(frontOf.a).toBe(0);
    expect(frontOf.b).toBe(1);
    expect(frontOf.c).toBe(2);
  });

  it('两个不可比点同处 front 0', () => {
    const points: ParetoPoint[] = [
      { id: 'x', quality: 5, cost: 1 },
      { id: 'y', quality: 1, cost: 5 },
    ];
    const ranked = paretoRank(points);
    expect(ranked.every((r) => r.front === 0)).toBe(true);
  });

  it('相等的点共享 front 0（互不支配）', () => {
    const points: ParetoPoint[] = [
      { id: 'p', quality: 4, cost: 4 },
      { id: 'q', quality: 4, cost: 4 },
    ];
    const ranked = paretoRank(points);
    expect(ranked.every((r) => r.front === 0)).toBe(true);
  });

  it('空输入返回空', () => {
    expect(paretoRank([])).toEqual([]);
  });

  it('paretoRankCandidates 映射市场候选（质量高成本低者更优）', () => {
    const candidates = [
      {
        id: 'm1',
        radarResolution: {
          radar: { task: 5, quality: 5, comm: 5, creativity: 5, reliability: 5, cost: 5 },
        },
      },
      {
        id: 'm2',
        radarResolution: {
          radar: { task: 1, quality: 1, comm: 1, creativity: 1, reliability: 1, cost: 1 },
        },
      },
    ];
    const ranked = paretoRankCandidates(candidates as never);
    const frontOf = Object.fromEntries(ranked.map((r) => [r.id, r.front]));
    expect(frontOf.m1).toBe(0);
    expect(frontOf.m2).toBe(1);
  });

  it('无六维候选按质量 0 计，沉底但不崩', () => {
    const candidates = [
      { id: 'n', radarResolution: { radar: null } },
      {
        id: 'g',
        radarResolution: {
          radar: { task: 4, quality: 4, comm: 4, creativity: 4, reliability: 4, cost: 4 },
        },
      },
    ];
    const ranked = paretoRankCandidates(candidates as never);
    const frontOf = Object.fromEntries(ranked.map((r) => [r.id, r.front]));
    expect(frontOf.g).toBe(0);
    expect(frontOf.n).toBe(1);
  });
});
