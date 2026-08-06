/**
 * tests/unit/userFit.test.ts
 *
 * 用户契合度引擎单测（模块 A · 设计 §6 Step 2）：
 *  - normalizeWeight  —— 归一化（Σ=1）/ 负数归零 / 全零与非法输入回退均匀权重
 *  - applyTaskBoost   —— effWeight = normalize(userWeight × dimBoost)
 *  - computeUserFit   —— userFit = Σ_d (radar[d]/5) × effWeight[d] ∈ [0,1]
 *  - weightDeviation  —— 心智权重相对默认权重的偏移（按 |delta| 降序）
 *
 * 关键公式断言全部手算，浮点用 toBeCloseTo。
 * 运行：env -u NODE_OPTIONS npx vitest run tests/unit/userFit.test.ts
 */
import { describe, it, expect } from 'vitest';
import type { RadarDim, RadarScore } from '@/types/evaluation';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import {
  DEFAULT_DIM_WEIGHT,
  applyTaskBoost,
  computeUserFit,
  normalizeWeight,
  weightDeviation,
} from '@/engine/marketplace/userFit';

/** 构造六维（未指定的维度取 fill 值） */
function radarOf(partial: Partial<RadarScore> = {}, fill = 0): RadarScore {
  return {
    task: fill,
    quality: fill,
    comm: fill,
    creativity: fill,
    reliability: fill,
    cost: fill,
    ...partial,
  };
}

/** 等权原始权重（未归一，每维 1） */
const EQUAL_RAW: Record<RadarDim, number> = {
  task: 1,
  quality: 1,
  comm: 1,
  creativity: 1,
  reliability: 1,
  cost: 1,
};

/** 权重向量求和 */
function sumWeight(w: Record<RadarDim, number>): number {
  return RADAR_DIMS.reduce((acc, dim) => acc + w[dim], 0);
}

describe('userFit · normalizeWeight（归一化）', () => {
  it('等权输入 → 每维 1/6，Σ=1', () => {
    const w = normalizeWeight(EQUAL_RAW);
    for (const dim of RADAR_DIMS) expect(w[dim]).toBeCloseTo(1 / 6, 10);
    expect(sumWeight(w)).toBeCloseTo(1, 10);
  });

  it('未归一输入按比例缩放，保持相对关系', () => {
    // task 权重是其余各维的 2 倍 → 归一后仍是 2 倍
    const w = normalizeWeight({ ...EQUAL_RAW, task: 2 });
    expect(sumWeight(w)).toBeCloseTo(1, 10);
    expect(w.task).toBeCloseTo(2 / 7, 10);
    expect(w.quality).toBeCloseTo(1 / 7, 10);
    expect(w.task / w.quality).toBeCloseTo(2, 10);
  });

  it('DEFAULT_DIM_WEIGHT 本身已是合法权重（Σ=1，归一化幂等）', () => {
    expect(sumWeight(DEFAULT_DIM_WEIGHT)).toBeCloseTo(1, 10);
    const w = normalizeWeight(DEFAULT_DIM_WEIGHT);
    for (const dim of RADAR_DIMS) expect(w[dim]).toBeCloseTo(DEFAULT_DIM_WEIGHT[dim], 10);
  });

  it('负数权重按 0 处理（权重不允许为负）', () => {
    const w = normalizeWeight({ ...EQUAL_RAW, cost: -5 });
    expect(w.cost).toBe(0);
    expect(w.task).toBeCloseTo(1 / 5, 10);
    expect(sumWeight(w)).toBeCloseTo(1, 10);
  });

  it('部分维度缺省 → 缺省维取 0，其余归一', () => {
    const w = normalizeWeight({ task: 1, quality: 1 });
    expect(w.task).toBeCloseTo(0.5, 10);
    expect(w.quality).toBeCloseTo(0.5, 10);
    expect(w.comm).toBe(0);
    expect(sumWeight(w)).toBeCloseTo(1, 10);
  });

  it('边界：null / undefined → 均匀权重（不产生 NaN）', () => {
    for (const input of [null, undefined]) {
      const w = normalizeWeight(input);
      for (const dim of RADAR_DIMS) expect(w[dim]).toBeCloseTo(1 / 6, 10);
      expect(sumWeight(w)).toBeCloseTo(1, 10);
    }
  });

  it('边界：全零 / 全负 → 回退均匀权重（避免除零 NaN 污染排序）', () => {
    const zero = normalizeWeight(radarOf({}, 0));
    for (const dim of RADAR_DIMS) expect(zero[dim]).toBeCloseTo(1 / 6, 10);

    const negative = normalizeWeight(radarOf({}, -1));
    for (const dim of RADAR_DIMS) expect(negative[dim]).toBeCloseTo(1 / 6, 10);
  });

  it('边界：NaN / Infinity 视为非法 → 该维归零，不污染结果', () => {
    const w = normalizeWeight({ ...EQUAL_RAW, task: Number.NaN, quality: Number.POSITIVE_INFINITY });
    expect(w.task).toBe(0);
    expect(w.quality).toBe(0);
    expect(sumWeight(w)).toBeCloseTo(1, 10);
    for (const dim of RADAR_DIMS) expect(Number.isFinite(w[dim])).toBe(true);
  });
});

describe('userFit · applyTaskBoost（心智权重 × 任务强调）', () => {
  it('无 dimBoost → 等价于纯归一化', () => {
    const base = normalizeWeight(EQUAL_RAW);
    for (const boost of [null, undefined]) {
      const w = applyTaskBoost(EQUAL_RAW, boost);
      for (const dim of RADAR_DIMS) expect(w[dim]).toBeCloseTo(base[dim], 10);
    }
  });

  it('单维 boost 1.5 → 手算校验（等权基线）', () => {
    // base = 1/6 各维；boosted: cost = 1/6×1.5 = 0.25，其余 1/6
    // Σ = 5/6 + 0.25 = 13/12 → cost = 0.25/(13/12) = 3/13 ≈ 0.230769
    //                          其余 = (1/6)/(13/12) = 2/13 ≈ 0.153846
    const w = applyTaskBoost(EQUAL_RAW, { cost: 1.5 });
    expect(w.cost).toBeCloseTo(3 / 13, 10);
    expect(w.task).toBeCloseTo(2 / 13, 10);
    expect(w.quality).toBeCloseTo(2 / 13, 10);
    expect(sumWeight(w)).toBeCloseTo(1, 10);
  });

  it('被强调的维度权重确实上升，未强调的被稀释', () => {
    const base = applyTaskBoost(EQUAL_RAW, null);
    const boosted = applyTaskBoost(EQUAL_RAW, { reliability: 1.5 });
    expect(boosted.reliability).toBeGreaterThan(base.reliability);
    for (const dim of RADAR_DIMS) {
      if (dim === 'reliability') continue;
      expect(boosted[dim]).toBeLessThan(base[dim]);
    }
    expect(sumWeight(boosted)).toBeCloseTo(1, 10);
  });

  it('多维 boost：系数越大权重占比越高', () => {
    const w = applyTaskBoost(EQUAL_RAW, { creativity: 1.4, quality: 1.2 });
    expect(w.creativity).toBeGreaterThan(w.quality);
    expect(w.quality).toBeGreaterThan(w.task);
    expect(w.creativity / w.quality).toBeCloseTo(1.4 / 1.2, 10);
    expect(sumWeight(w)).toBeCloseTo(1, 10);
  });

  it('boost 作用在非等权的心智权重上（乘性叠加）', () => {
    // DEFAULT: task .2 / quality .2 / comm .15 / creativity .15 / reliability .15 / cost .15
    // boost cost ×1.5 → cost = .225，Σ = 1.075 → cost = .225/1.075
    const w = applyTaskBoost(DEFAULT_DIM_WEIGHT, { cost: 1.5 });
    expect(w.cost).toBeCloseTo(0.225 / 1.075, 10);
    expect(w.task).toBeCloseTo(0.2 / 1.075, 10);
    expect(sumWeight(w)).toBeCloseTo(1, 10);
  });

  it('非法 boost 系数（0 / 负数 / NaN）视为 1，不改变该维', () => {
    const base = applyTaskBoost(EQUAL_RAW, null);
    const w = applyTaskBoost(EQUAL_RAW, {
      task: 0,
      quality: -2,
      comm: Number.NaN,
    });
    for (const dim of RADAR_DIMS) expect(w[dim]).toBeCloseTo(base[dim], 10);
  });

  it('boost 系数全为 1 → 权重不变', () => {
    const base = applyTaskBoost(DEFAULT_DIM_WEIGHT, null);
    const w = applyTaskBoost(DEFAULT_DIM_WEIGHT, {
      task: 1,
      quality: 1,
      comm: 1,
      creativity: 1,
      reliability: 1,
      cost: 1,
    });
    for (const dim of RADAR_DIMS) expect(w[dim]).toBeCloseTo(base[dim], 10);
  });
});

describe('userFit · computeUserFit（六维加权契合度）', () => {
  it('★ radar 全 5 分 + 等权 → userFit = 1', () => {
    expect(computeUserFit(radarOf({}, 5), EQUAL_RAW)).toBeCloseTo(1, 10);
  });

  it('★ radar 全 0 分 → userFit = 0', () => {
    expect(computeUserFit(radarOf({}, 0), EQUAL_RAW)).toBeCloseTo(0, 10);
  });

  it('radar 全 5 分在任意权重下恒为 1（权重 Σ=1 的必然结果）', () => {
    expect(computeUserFit(radarOf({}, 5), DEFAULT_DIM_WEIGHT)).toBeCloseTo(1, 10);
    expect(computeUserFit(radarOf({}, 5), { task: 1 })).toBeCloseTo(1, 10);
    expect(computeUserFit(radarOf({}, 5), applyTaskBoost(EQUAL_RAW, { cost: 1.5 }))).toBeCloseTo(
      1,
      10,
    );
  });

  it('radar 全 2.5 分（半分）→ userFit = 0.5', () => {
    expect(computeUserFit(radarOf({}, 2.5), EQUAL_RAW)).toBeCloseTo(0.5, 10);
  });

  it('★ 阶梯 radar 手算：(5,4,3,2,1,0) 等权 → 15/30 = 0.5', () => {
    const radar = radarOf({
      task: 5,
      quality: 4,
      comm: 3,
      creativity: 2,
      reliability: 1,
      cost: 0,
    });
    // Σ (radar/5)×(1/6) = (1+0.8+0.6+0.4+0.2+0)/6 = 3/6 = 0.5
    expect(computeUserFit(radar, EQUAL_RAW)).toBeCloseTo(0.5, 10);
  });

  it('★ 权重集中到单维 → userFit 等于该维归一分', () => {
    const radar = radarOf({ task: 4, quality: 1 }, 0);
    expect(computeUserFit(radar, { task: 1 })).toBeCloseTo(0.8, 10);
    expect(computeUserFit(radar, { quality: 1 })).toBeCloseTo(0.2, 10);
  });

  it('★ boost 后契合度向被强调维倾斜（省钱型候选因 cost 强调而受益）', () => {
    const cheapCandidate = radarOf({ cost: 5 }, 2); // cost 5，其余 2
    const before = computeUserFit(cheapCandidate, applyTaskBoost(EQUAL_RAW, null));
    const after = computeUserFit(cheapCandidate, applyTaskBoost(EQUAL_RAW, { cost: 1.5 }));
    // before = (2×5+5)/30 = 0.5
    expect(before).toBeCloseTo(0.5, 10);
    expect(after).toBeGreaterThan(before);
    // after = (2/5)×(2/13)×5 + (5/5)×(3/13) = 0.4×10/13 + 3/13 = 7/13
    expect(after).toBeCloseTo(7 / 13, 10);
  });

  it('★ boost 对弱势维候选则是惩罚', () => {
    const expensiveCandidate = radarOf({ cost: 0 }, 5); // cost 0，其余 5
    const before = computeUserFit(expensiveCandidate, applyTaskBoost(EQUAL_RAW, null));
    const after = computeUserFit(expensiveCandidate, applyTaskBoost(EQUAL_RAW, { cost: 1.5 }));
    expect(before).toBeCloseTo(5 / 6, 10);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(10 / 13, 10);
  });

  it('边界：radar 为 null / undefined → 0（无数据不参与竞争）', () => {
    expect(computeUserFit(null, EQUAL_RAW)).toBe(0);
    expect(computeUserFit(undefined, EQUAL_RAW)).toBe(0);
  });

  it('边界：权重为 null → 内部回退均匀权重，仍可算出契合度', () => {
    expect(computeUserFit(radarOf({}, 5), null)).toBeCloseTo(1, 10);
    expect(computeUserFit(radarOf({}, 3), null)).toBeCloseTo(0.6, 10);
  });

  it('边界：radar 越界值被夹取到 [0,5]', () => {
    expect(computeUserFit(radarOf({}, 10), EQUAL_RAW)).toBeCloseTo(1, 10);
    expect(computeUserFit(radarOf({}, -3), EQUAL_RAW)).toBeCloseTo(0, 10);
  });

  it('边界：radar 含 NaN → 该维按 0 计，不产生 NaN 结果', () => {
    const radar = radarOf({ task: Number.NaN }, 5);
    const fit = computeUserFit(radar, EQUAL_RAW);
    expect(Number.isNaN(fit)).toBe(false);
    expect(fit).toBeCloseTo(5 / 6, 10);
  });

  it('结果恒在 [0,1] 区间内', () => {
    const samples: RadarScore[] = [
      radarOf({}, 0),
      radarOf({}, 5),
      radarOf({ task: 5, cost: 0 }, 3),
      radarOf({}, 100),
    ];
    for (const radar of samples) {
      const fit = computeUserFit(radar, DEFAULT_DIM_WEIGHT);
      expect(fit).toBeGreaterThanOrEqual(0);
      expect(fit).toBeLessThanOrEqual(1);
    }
  });
});

describe('userFit · weightDeviation（心智偏移指示）', () => {
  it('权重等于基线 → 全部偏移为 0', () => {
    const deviations = weightDeviation(DEFAULT_DIM_WEIGHT);
    for (const item of deviations) expect(item.delta).toBeCloseTo(0, 10);
  });

  it('按偏移绝对值降序排列，最偏的维排第一', () => {
    // task 0.5，其余 0.1 → Σ=1；task delta = 0.5-0.2 = +0.3
    const deviations = weightDeviation({
      task: 0.5,
      quality: 0.1,
      comm: 0.1,
      creativity: 0.1,
      reliability: 0.1,
      cost: 0.1,
    });
    expect(deviations[0].dim).toBe('task');
    expect(deviations[0].delta).toBeCloseTo(0.3, 10);
    for (let i = 1; i < deviations.length; i += 1) {
      expect(Math.abs(deviations[i - 1].delta)).toBeGreaterThanOrEqual(
        Math.abs(deviations[i].delta),
      );
    }
  });

  it('覆盖全部六维且偏移之和为 0（两侧均已归一）', () => {
    const deviations = weightDeviation({ ...EQUAL_RAW, cost: 3 });
    expect(deviations).toHaveLength(RADAR_DIMS.length);
    expect(new Set(deviations.map((d) => d.dim)).size).toBe(RADAR_DIMS.length);
    const total = deviations.reduce((acc, item) => acc + item.delta, 0);
    expect(total).toBeCloseTo(0, 10);
  });

  it('正偏移 = 用户更看重该维（绩效回灌生效的可视证据）', () => {
    const deviations = weightDeviation({ ...EQUAL_RAW, cost: 3 });
    const cost = deviations.find((d) => d.dim === 'cost');
    expect(cost).toBeDefined();
    expect(cost?.delta).toBeGreaterThan(0);
  });
});
