/**
 * tests/unit/metaJudge.test.ts
 * 元评估引擎行为锁定（对评委本身的评估）。
 *
 * 覆盖：
 * - agreement 一致率计算
 * - krippendorffAlpha 二值一致性（完全一致=1、随机=0、反向=-1）
 * - diagnoseByDim 逐维诊断（最弱维排序）
 * - driftCheck 漂移检测（improved/degraded/insufficient）
 * - assessMetaJudge 主入口（总体可接受性、置信校准缺口）
 */
import { describe, it, expect } from 'vitest';
import {
  agreement,
  krippendorffAlpha,
  diagnoseByDim,
  driftCheck,
  assessMetaJudge,
  type MetaJudgeSample,
} from '@/engine/evaluation/metaJudge';

function sample(partial: Partial<MetaJudgeSample> & Pick<MetaJudgeSample, 'id' | 'gold' | 'judgeVerdict'>): MetaJudgeSample {
  return { judgeId: 'test-judge', ...partial };
}

describe('metaJudge · agreement', () => {
  it('全部一致 → accuracy=1', () => {
    const r = agreement([
      { gold: true, judgeVerdict: true },
      { gold: false, judgeVerdict: false },
    ]);
    expect(r.accuracy).toBe(1);
    expect(r.agree).toBe(2);
  });

  it('一半一致 → accuracy=0.5', () => {
    const r = agreement([
      { gold: true, judgeVerdict: true },
      { gold: false, judgeVerdict: true },
    ]);
    expect(r.accuracy).toBe(0.5);
  });

  it('空样本 → accuracy=0 不抛', () => {
    const r = agreement([]);
    expect(r.accuracy).toBe(0);
    expect(r.n).toBe(0);
  });
});

describe('metaJudge · krippendorffAlpha', () => {
  it('完全一致 → α=1', () => {
    const samples = [
      { gold: true, judgeVerdict: true },
      { gold: true, judgeVerdict: true },
      { gold: false, judgeVerdict: false },
      { gold: false, judgeVerdict: false },
    ];
    expect(krippendorffAlpha(samples)).toBe(1);
  });

  it('完全反向 → α=-1', () => {
    const samples = [
      { gold: true, judgeVerdict: false },
      { gold: true, judgeVerdict: false },
      { gold: false, judgeVerdict: true },
      { gold: false, judgeVerdict: true },
    ];
    expect(krippendorffAlpha(samples)).toBe(-1);
  });

  it('随机一致（对角无偏向）→ α 接近 0', () => {
    const samples = [
      { gold: true, judgeVerdict: true },
      { gold: true, judgeVerdict: false },
      { gold: false, judgeVerdict: true },
      { gold: false, judgeVerdict: false },
    ];
    expect(krippendorffAlpha(samples)).toBeCloseTo(0, 1);
  });

  it('样本不足 → 0', () => {
    expect(krippendorffAlpha([{ gold: true, judgeVerdict: true }])).toBe(0);
  });
});

describe('metaJudge · diagnoseByDim', () => {
  it('最弱维排最前，标注不可接受', () => {
    const samples = [
      sample({ id: '1', gold: true, judgeVerdict: true, dim: 'factuality' }),
      sample({ id: '2', gold: true, judgeVerdict: true, dim: 'factuality' }),
      sample({ id: '3', gold: true, judgeVerdict: true, dim: 'factuality' }),
      sample({ id: '4', gold: false, judgeVerdict: true, dim: 'logic' }), // logic 0%
      sample({ id: '5', gold: false, judgeVerdict: true, dim: 'logic' }),
    ];
    const byDim = diagnoseByDim(samples);
    expect(byDim[0].dim).toBe('logic');
    expect(byDim[0].accuracy).toBe(0);
    expect(byDim[0].acceptable).toBe(false);
    expect(byDim[1].dim).toBe('factuality');
    expect(byDim[1].acceptable).toBe(true);
  });

  it('无 dim → 归入 unspecified', () => {
    const byDim = diagnoseByDim([
      sample({ id: '1', gold: true, judgeVerdict: true }),
    ]);
    expect(byDim[0].dim).toBe('unspecified');
  });
});

describe('metaJudge · driftCheck', () => {
  it('样本不足 → insufficient', () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      sample({ id: `s${i}`, gold: true, judgeVerdict: true, ts: `2026-01-0${(i % 9) + 1}00:00Z` }),
    );
    const drift = driftCheck(samples);
    expect(drift.direction).toBe('insufficient');
  });

  it('近期变差 → degraded', () => {
    const early = Array.from({ length: 12 }, (_, i) =>
      sample({ id: `e${i}`, gold: true, judgeVerdict: true, ts: `2026-01-01T00:0${i}:00Z` }),
    );
    const late = Array.from({ length: 12 }, (_, i) =>
      sample({ id: `l${i}`, gold: true, judgeVerdict: false, ts: `2026-02-01T00:0${i}:00Z` }),
    );
    const drift = driftCheck([...early, ...late]);
    expect(drift.direction).toBe('degraded');
    expect(drift.drifted).toBe(true);
    expect(drift.delta).toBeLessThan(0);
  });

  it('近期变好 → improved', () => {
    const early = Array.from({ length: 12 }, (_, i) =>
      sample({ id: `e${i}`, gold: true, judgeVerdict: false, ts: `2026-01-01T00:0${i}:00Z` }),
    );
    const late = Array.from({ length: 12 }, (_, i) =>
      sample({ id: `l${i}`, gold: true, judgeVerdict: true, ts: `2026-02-01T00:0${i}:00Z` }),
    );
    const drift = driftCheck([...early, ...late]);
    expect(drift.direction).toBe('improved');
  });

  it('稳定 → stable', () => {
    // 每半窗口恰好 2 个判错（一致率 10/12 ≈ 0.833），两半几乎无差异
    const makeHalf = (prefix: string, startDay: number) =>
      Array.from({ length: 12 }, (_, i) =>
        sample({
          id: `${prefix}${i}`,
          gold: true,
          judgeVerdict: i >= 10, // 后 2 个判错
          ts: `2026-01-${String(startDay + i).padStart(2, '0')}00:00Z`,
        }),
      );
    const drift = driftCheck([...makeHalf('e', 1), ...makeHalf('l', 15)]);
    expect(drift.direction).toBe('stable');
    expect(drift.drifted).toBe(false);
  });
});

describe('metaJudge · assessMetaJudge', () => {
  it('高质量评委 → overallAcceptable=true，无漂移，置信校准缺口小', () => {
    const samples = Array.from({ length: 30 }, (_, i) =>
      sample({
        id: `s${i}`,
        gold: true,
        judgeVerdict: true,
        confidence: 0.95,
        dim: 'factuality',
        ts: `2026-01-${String((i % 28) + 1).padStart(2, '0')}00:00Z`,
      }),
    );
    const report = assessMetaJudge(samples);
    expect(report.overallAcceptable).toBe(true);
    expect(report.accuracy).toBe(1);
    expect(report.drift.direction).toBe('stable');
    expect(report.calibrationGap).not.toBeNull();
    expect(report.byDim.length).toBe(1);
    expect(report.weakestDim?.dim).toBe('factuality');
  });

  it('低质量评委 → overallAcceptable=false，最弱维标注不可接受', () => {
    const samples = Array.from({ length: 20 }, (_, i) =>
      sample({
        id: `s${i}`,
        gold: true,
        judgeVerdict: false, // 全部判错
        confidence: 0.9, // 过度自信
        dim: 'logic',
      }),
    );
    const report = assessMetaJudge(samples);
    expect(report.overallAcceptable).toBe(false);
    expect(report.accuracy).toBe(0);
    expect(report.weakestDim?.acceptable).toBe(false);
    // 置信校准缺口 = |0.9 - 0| = 0.9 → 过度自信被检出
    expect(report.calibrationGap).toBeCloseTo(0.9, 1);
  });

  it('阈值可配置', () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      sample({ id: `s${i}`, gold: true, judgeVerdict: i % 5 === 0 ? false : true }),
    );
    // accuracy = 0.8；默认阈值 0.67 → 可接受；调高到 0.9 → 不可接受
    expect(assessMetaJudge(samples).overallAcceptable).toBe(true);
    expect(assessMetaJudge(samples, { acceptableThreshold: 0.9 }).overallAcceptable).toBe(false);
  });
});
