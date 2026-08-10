import { describe, it, expect } from 'vitest';
import { passK, isAllDimPass } from '@/engine/evaluation/passK';
import type { RadarScore } from '@/types/evaluation';

const r = (over: Partial<RadarScore>): RadarScore => ({
  task: 4,
  quality: 4,
  comm: 4,
  creativity: 4,
  reliability: 4,
  cost: 4,
  ...over,
});

describe('passK', () => {
  it('allPass=true 当每次运行都全维达阈值', () => {
    const res = passK([r({}), r({}), r({})], { k: 3, threshold: 3.5 });
    expect(res.allPass).toBe(true);
    expect(res.k).toBe(3);
    expect(res.passRate).toBe(1);
    expect(res.sampleCount).toBe(3);
  });

  it('allPass=false 当有一次跌破阈值', () => {
    const res = passK([r({}), r({ task: 2 }), r({})], { k: 3, threshold: 3.5 });
    expect(res.allPass).toBe(false);
    expect(res.passRate).toBeLessThan(1);
    // task 维仅 2/3 次达阈值
    expect(res.dimPassRate.task).toBeCloseTo(2 / 3, 2);
  });

  it('空输入 => allPass=false 且维度归零', () => {
    const res = passK([], { k: 3 });
    expect(res.allPass).toBe(false);
    expect(res.sampleCount).toBe(0);
    expect(res.k).toBe(3);
    expect(res.dimPassRate.task).toBe(0);
  });

  it('meanRadar 为逐维均值', () => {
    const res = passK([r({ task: 2 }), r({ task: 4 })], { k: 2 });
    expect(res.meanRadar.task).toBe(3);
    expect(res.meanRadar.quality).toBe(4);
  });

  it('isAllDimPass 尊重阈值与 null', () => {
    expect(isAllDimPass(r({ task: 3 }), { threshold: 3.5 })).toBe(false);
    expect(isAllDimPass(r({ task: 4 }), { threshold: 3.5 })).toBe(true);
    expect(isAllDimPass(null)).toBe(false);
  });

  it('可限定判定维度（只判部分维）', () => {
    // task 不达标，但只判 quality → 仍视为全过
    const res = passK([r({ task: 1 })], { threshold: 3.5, dims: ['quality'] });
    expect(res.allPass).toBe(true);
  });
});
