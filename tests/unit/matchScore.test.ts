/**
 * tests/unit/matchScore.test.ts
 *
 * 智能匹配排序引擎单测（模块 A）。
 *
 * 严格按设计公式手算期望值并断言：
 *   effWeight = normalize(userWeight × dimBoost)
 *   userFit   = Σ_d (radar[d]/5) × effWeight[d]
 *   tagMatch  = |A∩B| / |A∪B|（任一侧空集 → 0.5 中性）
 *   costPerf  = clamp((mean(radar)/5) / (budgetNum/budgetRef), 0, 1)
 *   perfBoost = s3Total != null ? s3Total/100 : 0.5
 *   total     = 100 × (0.50·userFit + 0.20·tagMatch + 0.15·costPerf + 0.15·perfBoost)
 *
 * 覆盖：子项纯函数 / 总分手算 / 高低契合排序 / 权重变化改序 / 无六维沉底 / 边界。
 * 运行：env -u NODE_OPTIONS npx vitest run tests/unit/matchScore.test.ts
 */
import { describe, it, expect } from 'vitest';
import type { RadarDim, RadarScore } from '@/types/evaluation';
import type { TaskProfile } from '@/types/marketplace';
import {
  DEFAULT_MATCH_WEIGHTS,
  NEUTRAL_PERF_BOOST,
  NEUTRAL_TAG_MATCH,
  budgetRefOf,
  computeCostPerf,
  computePerfBoost,
  jaccard,
  matchScore,
  sortByMatch,
  type MatchCandidateInput,
  type MatchContext,
} from '@/engine/marketplace/matchScore';

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

/** 等权心智权重（未归一） */
const EQUAL_WEIGHT: Record<RadarDim, number> = {
  task: 1,
  quality: 1,
  comm: 1,
  creativity: 1,
  reliability: 1,
  cost: 1,
};

/** 省钱型候选：cost 5，其余 2（radar 和 = 15，mean = 2.5） */
const CHEAP_RADAR = radarOf({ cost: 5 }, 2);
/** 实力型候选：task/quality 5，其余 2（radar 和 = 18，mean = 3） */
const STRONG_RADAR = radarOf({ task: 5, quality: 5 }, 2);

function candidate(over: Partial<MatchCandidateInput> = {}): MatchCandidateInput {
  return {
    id: 'c1',
    tags: ['通用'],
    budgetNum: 100,
    radar: radarOf({}, 5),
    ...over,
  };
}

function profileOf(over: Partial<TaskProfile> = {}): TaskProfile {
  return { jobType: null, dimBoost: {}, tags: [], ...over };
}

describe('matchScore · jaccard（标签契合）', () => {
  it('完全相同 → 1', () => {
    expect(jaccard(['代码', '稳定'], ['代码', '稳定'])).toBeCloseTo(1, 10);
  });

  it('部分交集 → |A∩B|/|A∪B|', () => {
    // A={a,b} B={b,c} → 交 1，并 3
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 10);
    // A={代码,稳定} B={代码,低成本,制图} → 交 1，并 4
    expect(jaccard(['代码', '稳定'], ['代码', '低成本', '制图'])).toBeCloseTo(0.25, 10);
  });

  it('完全不相交 → 0', () => {
    expect(jaccard(['a'], ['b'])).toBe(0);
  });

  it('任一侧为空集 → 0.5 中性（不惩罚也不奖励）', () => {
    expect(jaccard([], ['a'])).toBe(NEUTRAL_TAG_MATCH);
    expect(jaccard(['a'], [])).toBe(NEUTRAL_TAG_MATCH);
    expect(jaccard([], [])).toBe(NEUTRAL_TAG_MATCH);
    expect(jaccard(null, ['a'])).toBe(NEUTRAL_TAG_MATCH);
    expect(jaccard(undefined, undefined)).toBe(NEUTRAL_TAG_MATCH);
  });

  it('对大小写与首尾空格不敏感，并自动去重', () => {
    expect(jaccard([' Code '], ['code'])).toBeCloseTo(1, 10);
    expect(jaccard(['a', 'a', 'A'], ['a'])).toBeCloseTo(1, 10);
  });

  it('全空白标签被剔除后视为空集 → 0.5', () => {
    expect(jaccard(['  ', ''], ['a'])).toBe(NEUTRAL_TAG_MATCH);
  });
});

describe('matchScore · computeCostPerf（性价比）', () => {
  it('报价等于参照价 → costPerf = 能力均值归一', () => {
    // mean=5 → ability=1；relativeCost=1 → 1
    expect(computeCostPerf(radarOf({}, 5), 100, 100)).toBeCloseTo(1, 10);
    // mean=2.5 → ability=0.5；relativeCost=1 → 0.5
    expect(computeCostPerf(CHEAP_RADAR, 100, 100)).toBeCloseTo(0.5, 10);
  });

  it('报价低于参照价 → 性价比提升（可达上限 1）', () => {
    // ability=0.5，relativeCost=0.5 → 1
    expect(computeCostPerf(CHEAP_RADAR, 100, 200)).toBeCloseTo(1, 10);
  });

  it('报价高于参照价 → 性价比下降', () => {
    // ability=1，relativeCost=2 → 0.5
    expect(computeCostPerf(radarOf({}, 5), 200, 100)).toBeCloseTo(0.5, 10);
    // ability=0.5，relativeCost=3 → 1/6
    expect(computeCostPerf(CHEAP_RADAR, 300, 100)).toBeCloseTo(1 / 6, 10);
  });

  it('本候选免费（budgetNum<=0）→ 1', () => {
    expect(computeCostPerf(radarOf({}, 3), 0, 100)).toBe(1);
    expect(computeCostPerf(radarOf({}, 3), -50, 100)).toBe(1);
  });

  it('全列表免费（budgetRef<=0）→ 有能力得 1，零能力得 0', () => {
    expect(computeCostPerf(radarOf({}, 3), 0, 0)).toBe(1);
    expect(computeCostPerf(radarOf({}, 0), 0, 0)).toBe(0);
  });

  it('边界：radar 为 null → 0', () => {
    expect(computeCostPerf(null, 100, 100)).toBe(0);
    expect(computeCostPerf(undefined, 100, 100)).toBe(0);
  });

  it('结果恒被夹取在 [0,1]', () => {
    expect(computeCostPerf(radarOf({}, 5), 1, 1000)).toBe(1);
    expect(computeCostPerf(radarOf({}, 1), 100000, 1)).toBeGreaterThanOrEqual(0);
  });
});

describe('matchScore · computePerfBoost（S3 绩效回流）', () => {
  it('有绩效数据 → s3Total/100', () => {
    expect(computePerfBoost(80)).toBeCloseTo(0.8, 10);
    expect(computePerfBoost(0)).toBeCloseTo(0, 10);
    expect(computePerfBoost(100)).toBeCloseTo(1, 10);
  });

  it('★ 无绩效数据 → 0.5 中性值', () => {
    expect(computePerfBoost(null)).toBe(NEUTRAL_PERF_BOOST);
    expect(computePerfBoost(undefined)).toBe(NEUTRAL_PERF_BOOST);
    expect(computePerfBoost(Number.NaN)).toBe(NEUTRAL_PERF_BOOST);
  });

  it('越界值被夹取到 [0,1]', () => {
    expect(computePerfBoost(150)).toBe(1);
    expect(computePerfBoost(-20)).toBe(0);
  });
});

describe('matchScore · budgetRefOf（报价参照）', () => {
  it('取列表最高报价', () => {
    expect(budgetRefOf([{ budgetNum: 100 }, { budgetNum: 300 }, { budgetNum: 50 }])).toBe(300);
  });

  it('空列表 / 全零 → 0', () => {
    expect(budgetRefOf([])).toBe(0);
    expect(budgetRefOf([{ budgetNum: 0 }, { budgetNum: 0 }])).toBe(0);
  });

  it('忽略非法值与负数', () => {
    expect(budgetRefOf([{ budgetNum: Number.NaN }, { budgetNum: 200 }, { budgetNum: -5 }])).toBe(
      200,
    );
  });
});

describe('matchScore · 总分手算校验', () => {
  it('★ 满分候选 + 无标签 + 无绩效 → 82.5', () => {
    // userFit=1；tagMatch=0.5（需求无标签）；costPerf=1；perfBoost=0.5
    // total = 100×(0.5×1 + 0.2×0.5 + 0.15×1 + 0.15×0.5) = 82.5
    const result = matchScore(candidate({ radar: radarOf({}, 5), budgetNum: 100 }), profileOf(), {
      userWeight: EQUAL_WEIGHT,
      budgetRef: 100,
    });
    expect(result).not.toBeNull();
    expect(result?.userFit).toBeCloseTo(1, 10);
    expect(result?.tagMatch).toBeCloseTo(0.5, 10);
    expect(result?.costPerf).toBeCloseTo(1, 10);
    expect(result?.perfBoost).toBeCloseTo(0.5, 10);
    expect(result?.total).toBeCloseTo(82.5, 5);
  });

  it('★ 阶梯 radar + 标签全中 + S3=80 → 72.0（逐项手算）', () => {
    // radar=(5,4,3,2,1,0)：userFit=0.5；mean=2.5 → ability=0.5
    // budgetNum=100 / budgetRef=200 → relativeCost=0.5 → costPerf=1
    // tagMatch=1（完全命中）；perfBoost=80/100=0.8
    // total = 100×(0.5×0.5 + 0.2×1 + 0.15×1 + 0.15×0.8) = 72.0
    const result = matchScore(
      candidate({
        tags: ['代码'],
        radar: radarOf({ task: 5, quality: 4, comm: 3, creativity: 2, reliability: 1, cost: 0 }),
        budgetNum: 100,
        stageScoreTotal: 80,
      }),
      profileOf({ tags: ['代码'] }),
      { userWeight: EQUAL_WEIGHT, budgetRef: 200 },
    );
    expect(result?.userFit).toBeCloseTo(0.5, 10);
    expect(result?.tagMatch).toBeCloseTo(1, 10);
    expect(result?.costPerf).toBeCloseTo(1, 10);
    expect(result?.perfBoost).toBeCloseTo(0.8, 10);
    expect(result?.total).toBeCloseTo(72.0, 5);
  });

  it('★ 全零候选（radar 全 0、免费、无绩效）→ 仅剩标签与绩效中性项', () => {
    // userFit=0；tagMatch=0.5；costPerf=1（免费）；perfBoost=0.5
    // total = 100×(0 + 0.1 + 0.15 + 0.075) = 32.5
    const result = matchScore(
      candidate({ radar: radarOf({}, 0), budgetNum: 0 }),
      profileOf(),
      { userWeight: EQUAL_WEIGHT, budgetRef: 100 },
    );
    expect(result?.userFit).toBeCloseTo(0, 10);
    expect(result?.total).toBeCloseTo(32.5, 5);
  });

  it('breakdown 回填实际使用的四项权重', () => {
    const result = matchScore(candidate(), profileOf(), {
      userWeight: EQUAL_WEIGHT,
      budgetRef: 100,
    });
    expect(result?.weights).toEqual(DEFAULT_MATCH_WEIGHTS);
  });

  it('各子项与总分均落在合法区间', () => {
    const result = matchScore(candidate(), profileOf({ tags: ['通用'] }), {
      userWeight: EQUAL_WEIGHT,
      budgetRef: 100,
    });
    expect(result).not.toBeNull();
    for (const key of ['userFit', 'tagMatch', 'costPerf', 'perfBoost'] as const) {
      expect(result?.[key]).toBeGreaterThanOrEqual(0);
      expect(result?.[key]).toBeLessThanOrEqual(1);
    }
    expect(result?.total).toBeGreaterThanOrEqual(0);
    expect(result?.total).toBeLessThanOrEqual(100);
  });
});

describe('matchScore · 高契合候选分高于低契合候选', () => {
  const ctx: MatchContext = { userWeight: EQUAL_WEIGHT, budgetRef: 100 };

  it('同价同标签下，六维更强者分更高', () => {
    const weak = matchScore(candidate({ id: 'weak', radar: radarOf({}, 2) }), profileOf(), ctx);
    const strong = matchScore(candidate({ id: 'strong', radar: radarOf({}, 5) }), profileOf(), ctx);
    expect(strong!.total).toBeGreaterThan(weak!.total);
  });

  it('六维相同时，标签命中者分更高', () => {
    const task = profileOf({ tags: ['代码', '稳定'] });
    const hit = matchScore(candidate({ id: 'hit', tags: ['代码', '稳定'] }), task, ctx);
    const miss = matchScore(candidate({ id: 'miss', tags: ['制图', '创意'] }), task, ctx);
    expect(hit!.tagMatch).toBeCloseTo(1, 10);
    expect(miss!.tagMatch).toBeCloseTo(0, 10);
    expect(hit!.total).toBeGreaterThan(miss!.total);
  });

  it('六维相同时，报价更低者分更高', () => {
    const cheap = matchScore(
      candidate({ id: 'cheap', radar: radarOf({}, 3), budgetNum: 50 }),
      profileOf(),
      { userWeight: EQUAL_WEIGHT, budgetRef: 200 },
    );
    const pricey = matchScore(
      candidate({ id: 'pricey', radar: radarOf({}, 3), budgetNum: 200 }),
      profileOf(),
      { userWeight: EQUAL_WEIGHT, budgetRef: 200 },
    );
    expect(cheap!.total).toBeGreaterThan(pricey!.total);
  });

  it('六维相同时，S3 绩效更高者分更高；无绩效者落在两者之间（中性 0.5）', () => {
    const high = matchScore(candidate({ id: 'h', stageScoreTotal: 90 }), profileOf(), ctx);
    const none = matchScore(candidate({ id: 'n' }), profileOf(), ctx);
    const low = matchScore(candidate({ id: 'l', stageScoreTotal: 20 }), profileOf(), ctx);
    expect(high!.total).toBeGreaterThan(none!.total);
    expect(none!.total).toBeGreaterThan(low!.total);
  });
});

describe('matchScore · 权重变化导致排序变化（§7.3 绩效回灌闭环）', () => {
  const cheapCandidate = candidate({ id: 'cheap', radar: CHEAP_RADAR });
  const strongCandidate = candidate({ id: 'strong', radar: STRONG_RADAR });
  const task = profileOf({ tags: ['通用'] });

  it('★ 等权心智：实力型（mean 3）胜出', () => {
    const ctx: MatchContext = { userWeight: EQUAL_WEIGHT, budgetRef: 100 };
    const cheap = matchScore(cheapCandidate, task, ctx)!;
    const strong = matchScore(strongCandidate, task, ctx)!;
    // cheap: userFit=15/30=0.5, tag=1, costPerf=0.5, perf=0.5 → 100×0.6 = 60.0
    // strong: userFit=18/30=0.6, tag=1, costPerf=0.6, perf=0.5 → 100×0.665 = 66.5
    expect(cheap.userFit).toBeCloseTo(0.5, 10);
    expect(strong.userFit).toBeCloseTo(0.6, 10);
    expect(cheap.total).toBeCloseTo(60.0, 5);
    expect(strong.total).toBeCloseTo(66.5, 5);
    expect(strong.total).toBeGreaterThan(cheap.total);
  });

  it('★ 心智权重偏向 cost 后：省钱型反超（排序翻转）', () => {
    // userWeight cost=5，其余 1 → Σ=10 → cost 0.5，其余 0.1
    // cheap  userFit = 0.4×0.1×5 + 1×0.5   = 0.70 → 100×(0.35+0.2+0.075+0.075) = 70.0
    // strong userFit = 0.1+0.1+0.4×0.1×3+0.4×0.5 = 0.52 → 100×(0.26+0.2+0.09+0.075) = 62.5
    const ctx: MatchContext = {
      userWeight: { ...EQUAL_WEIGHT, cost: 5 },
      budgetRef: 100,
    };
    const cheap = matchScore(cheapCandidate, task, ctx)!;
    const strong = matchScore(strongCandidate, task, ctx)!;
    expect(cheap.userFit).toBeCloseTo(0.7, 10);
    expect(strong.userFit).toBeCloseTo(0.52, 10);
    expect(cheap.total).toBeCloseTo(70.0, 5);
    expect(strong.total).toBeCloseTo(62.5, 5);
    expect(cheap.total).toBeGreaterThan(strong.total);
  });

  it('★ 任务画像 dimBoost 强调 cost 后：省钱型同样反超', () => {
    // effWeight: cost = 0.375，其余 0.125
    // cheap  userFit = 0.4×0.125×5 + 0.375 = 0.625
    // strong userFit = 0.125+0.125+0.4×0.125×3+0.4×0.375 = 0.55
    const ctx: MatchContext = { userWeight: EQUAL_WEIGHT, budgetRef: 100 };
    const boostedTask = profileOf({ tags: ['通用'], dimBoost: { cost: 3 } });
    const cheap = matchScore(cheapCandidate, boostedTask, ctx)!;
    const strong = matchScore(strongCandidate, boostedTask, ctx)!;
    expect(cheap.userFit).toBeCloseTo(0.625, 10);
    expect(strong.userFit).toBeCloseTo(0.55, 10);
    expect(cheap.total).toBeGreaterThan(strong.total);
  });

  it('自定义四项权重：fit 独占 → total 完全由 userFit 决定', () => {
    const result = matchScore(candidate({ radar: radarOf({}, 4) }), profileOf(), {
      userWeight: EQUAL_WEIGHT,
      budgetRef: 100,
      weights: { fit: 1, tag: 0, cost: 0, perf: 0 },
    });
    expect(result?.userFit).toBeCloseTo(0.8, 10);
    expect(result?.total).toBeCloseTo(80.0, 5);
  });

  it('自定义权重和不为 1 时按权重和归一，total 仍在 [0,100]', () => {
    // 四项等权（各 1，Σ=4）→ total = 100×(userFit+tag+cost+perf)/4
    const result = matchScore(
      candidate({ radar: radarOf({}, 5), budgetNum: 100, stageScoreTotal: 100 }),
      profileOf({ tags: ['通用'] }),
      {
        userWeight: EQUAL_WEIGHT,
        budgetRef: 100,
        weights: { fit: 1, tag: 1, cost: 1, perf: 1 },
      },
    );
    // 四项均为 1 → 归一后 total = 100
    expect(result?.total).toBeCloseTo(100, 5);
  });
});

describe('matchScore · 无六维候选不参与打分', () => {
  it('★ radar 为 null → 返回 null（排序沉底 + 显示 S1 初审按钮）', () => {
    const result = matchScore(candidate({ radar: null }), profileOf(), {
      userWeight: EQUAL_WEIGHT,
      budgetRef: 100,
    });
    expect(result).toBeNull();
  });
});

describe('matchScore · sortByMatch（排序）', () => {
  it('按 total 降序排列', () => {
    const items = [
      { id: 'a', match: { total: 60 } },
      { id: 'b', match: { total: 90 } },
      { id: 'c', match: { total: 75 } },
    ] as Array<{ id: string; match: { total: number } | null }>;
    expect(sortByMatch(items).map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('★ 无 match 的候选一律沉底', () => {
    const items = [
      { id: 'none1', match: null },
      { id: 'a', match: { total: 60 } },
      { id: 'none2', match: undefined },
      { id: 'b', match: { total: 90 } },
    ] as Array<{ id: string; match?: { total: number } | null }>;
    expect(sortByMatch(items).map((i) => i.id)).toEqual(['b', 'a', 'none1', 'none2']);
  });

  it('分数相同时保持原有相对顺序（稳定排序）', () => {
    const items = [
      { id: 'x', match: { total: 70 } },
      { id: 'y', match: { total: 70 } },
      { id: 'z', match: { total: 70 } },
    ] as Array<{ id: string; match: { total: number } | null }>;
    expect(sortByMatch(items).map((i) => i.id)).toEqual(['x', 'y', 'z']);
  });

  it('不修改原数组（返回新数组）', () => {
    const items = [
      { id: 'a', match: { total: 10 } },
      { id: 'b', match: { total: 20 } },
    ] as Array<{ id: string; match: { total: number } | null }>;
    const sorted = sortByMatch(items);
    expect(sorted).not.toBe(items);
    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('空数组安全', () => {
    expect(sortByMatch([])).toEqual([]);
  });
});
