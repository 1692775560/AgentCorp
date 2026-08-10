import { describe, it, expect } from 'vitest';
import { aggregateRadars, majorityVerdict } from '@/services/judgeEnsemble';
import type { RadarScore, Verdict } from '@/types/evaluation';

describe('aggregateRadars', () => {
  it('逐维平均', () => {
    const a: RadarScore = {
      task: 2,
      quality: 4,
      comm: 0,
      creativity: 0,
      reliability: 0,
      cost: 0,
    };
    const b: RadarScore = {
      task: 4,
      quality: 2,
      comm: 0,
      creativity: 0,
      reliability: 0,
      cost: 0,
    };
    const m = aggregateRadars([a, b]);
    expect(m.task).toBe(3);
    expect(m.quality).toBe(3);
  });

  it('空输入 => 全零雷达', () => {
    expect(aggregateRadars([]).task).toBe(0);
  });

  it('过滤非对象元素（防御式）', () => {
    const a: RadarScore = {
      task: 4,
      quality: 4,
      comm: 4,
      creativity: 4,
      reliability: 4,
      cost: 4,
    };
    const m = aggregateRadars([a, null as unknown as RadarScore]);
    expect(m.task).toBe(4);
  });
});

describe('majorityVerdict', () => {
  it('取出现次数最多的判定', () => {
    expect(majorityVerdict(['MVP', 'MVP', 'OBSERVE'] as Verdict[])).toBe('MVP');
  });

  it('忽略 null', () => {
    expect(majorityVerdict([null, 'FIRED', 'FIRED'] as Verdict[])).toBe('FIRED');
  });

  it('全部 null/undefined => null', () => {
    expect(majorityVerdict([null, undefined])).toBeNull();
  });

  it('单样本直接返回', () => {
    expect(majorityVerdict(['OBSERVE'] as Verdict[])).toBe('OBSERVE');
  });
});
