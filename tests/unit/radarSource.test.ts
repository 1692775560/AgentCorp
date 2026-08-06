/**
 * tests/unit/radarSource.test.ts
 *
 * 六维三源解析层单测（模块 A · 设计 §5.1）：
 *  - resolveAgentRadar   —— 优先级 evaluation → prescreen → heuristic → none
 *  - latestStageScore    —— 按 stage 过滤 + 按 ts 择新
 *  - radarFromStageScore —— StageScore.objective → 六维（craft 维忽略）
 *  - heuristicRadar      —— persona 启发式（确定性、无随机）
 *  - 工具函数            —— clampToHalfStep / radarMean / isMeaningfulRadar / parseBudgetNumber
 *
 * 测试重点：不同输入来源返回正确的 RadarSourceKind。
 * 运行：env -u NODE_OPTIONS npx vitest run tests/unit/radarSource.test.ts
 */
import { describe, it, expect } from 'vitest';
import type { EvaluationProfile, RadarScore, StageScore } from '@/types/evaluation';
import {
  RADAR_SOURCE_LABELS,
  clampToHalfStep,
  heuristicRadar,
  isMeaningfulRadar,
  latestStageScore,
  parseBudgetNumber,
  radarFromStageScore,
  radarMean,
  resolveAgentRadar,
  type HeuristicSeed,
} from '@/engine/marketplace/radarSource';

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

/**
 * 最小可用 EvaluationProfile。
 * resolveAgentRadar 仅读取 radarLatest，其余字段与本用例无关，
 * 故以类型断言构造精简夹具，避免无意义的样板数据淹没断言意图。
 */
function profileWith(radarLatest: RadarScore): EvaluationProfile {
  return { agentId: 'a1', radarLatest } as unknown as EvaluationProfile;
}

/** 构造一张阶段评分卡（字段完整，便于复用） */
function stageScoreOf(over: Partial<StageScore> = {}): StageScore {
  return {
    agentId: 'a1',
    stage: 'preScreen',
    jobType: 'code',
    objective: [],
    subjective: { agentId: 'a1', stage: 'preScreen', scores: {}, scoredBy: 'qa', ts: '2026-07-01T00:00:00Z' },
    objectiveWeight: 0.6,
    subjectiveWeight: 0.4,
    objectiveScore: 70,
    subjectiveScore: 60,
    total: 66,
    verdict: 'OBSERVE',
    craftScores: { jobType: 'code', dims: {}, downweighted: [], evidence: {} },
    ts: '2026-07-01T00:00:00Z',
    ...over,
  };
}

/** 六维客观项（供 preScreen 评分卡） */
function objectiveSix(score: number) {
  return (['task', 'quality', 'comm', 'creativity', 'reliability', 'cost'] as const).map((dim) => ({
    dim,
    score,
    source: 'judge' as const,
    weight: 1 / 6,
  }));
}

describe('radarSource · 工具函数', () => {
  it('clampToHalfStep：夹取 [0,5] 并对齐 0.5 步进', () => {
    expect(clampToHalfStep(3.26)).toBe(3.5);
    expect(clampToHalfStep(3.24)).toBe(3);
    expect(clampToHalfStep(4.75)).toBe(5);
    expect(clampToHalfStep(-1)).toBe(0);
    expect(clampToHalfStep(9)).toBe(5);
    expect(clampToHalfStep(Number.NaN)).toBe(0);
  });

  it('radarMean：六维均值，null → 0', () => {
    expect(radarMean(radarOf({}, 5))).toBeCloseTo(5, 10);
    expect(radarMean(radarOf({ task: 5, quality: 4, comm: 3, creativity: 2, reliability: 1, cost: 0 }))).toBeCloseTo(2.5, 10);
    expect(radarMean(null)).toBe(0);
    expect(radarMean(undefined)).toBe(0);
  });

  it('isMeaningfulRadar：全零 / null 视为无效', () => {
    expect(isMeaningfulRadar(radarOf({}, 3))).toBe(true);
    expect(isMeaningfulRadar(radarOf({ task: 0.5 }, 0))).toBe(true);
    expect(isMeaningfulRadar(radarOf({}, 0))).toBe(false);
    expect(isMeaningfulRadar(null)).toBe(false);
    expect(isMeaningfulRadar(undefined)).toBe(false);
  });

  it('parseBudgetNumber：解析常见报价写法', () => {
    expect(parseBudgetNumber('¥299/月')).toBe(299);
    expect(parseBudgetNumber('299 元')).toBe(299);
    expect(parseBudgetNumber('1,299 元')).toBe(1299);
    expect(parseBudgetNumber('99.5')).toBeCloseTo(99.5, 10);
    expect(parseBudgetNumber('免费')).toBe(0);
    expect(parseBudgetNumber('Free')).toBe(0);
    expect(parseBudgetNumber('面议')).toBe(0);
    expect(parseBudgetNumber('')).toBe(0);
    expect(parseBudgetNumber(null)).toBe(0);
    expect(parseBudgetNumber(undefined)).toBe(0);
  });

  it('四种来源均有中文角标文案', () => {
    expect(RADAR_SOURCE_LABELS.evaluation).toBe('已评估');
    expect(RADAR_SOURCE_LABELS.prescreen).toBe('初审');
    expect(RADAR_SOURCE_LABELS.heuristic).toBe('预估');
    expect(RADAR_SOURCE_LABELS.none).toBe('未评估');
  });
});

describe('radarSource · latestStageScore（按阶段择新）', () => {
  it('只取指定阶段，并按 ts 取最新一张', () => {
    const scores = [
      stageScoreOf({ stage: 'preScreen', ts: '2026-07-01T00:00:00Z', total: 10 }),
      stageScoreOf({ stage: 'preScreen', ts: '2026-07-05T00:00:00Z', total: 20 }),
      stageScoreOf({ stage: 'performance', ts: '2026-07-09T00:00:00Z', total: 30 }),
    ];
    expect(latestStageScore(scores, 'preScreen')?.total).toBe(20);
    expect(latestStageScore(scores, 'performance')?.total).toBe(30);
  });

  it('阶段不存在 / 空列表 / null → null', () => {
    expect(latestStageScore([stageScoreOf({ stage: 'preScreen' })], 'interview')).toBeNull();
    expect(latestStageScore([], 'preScreen')).toBeNull();
    expect(latestStageScore(null, 'preScreen')).toBeNull();
    expect(latestStageScore(undefined, 'preScreen')).toBeNull();
  });

  it('乱序输入也能稳定取到最新（与数组顺序无关）', () => {
    const scores = [
      stageScoreOf({ ts: '2026-07-09T00:00:00Z', total: 90 }),
      stageScoreOf({ ts: '2026-07-01T00:00:00Z', total: 10 }),
    ];
    expect(latestStageScore(scores, 'preScreen')?.total).toBe(90);
  });
});

describe('radarSource · radarFromStageScore（评分卡 → 六维）', () => {
  it('抽取六维客观项并对齐 0.5 步进', () => {
    const radar = radarFromStageScore(stageScoreOf({ objective: objectiveSix(4.26) }));
    expect(radar).not.toBeNull();
    expect(radar?.task).toBe(4.5);
    expect(radar?.cost).toBe(4.5);
  });

  it('只命中部分维度时，其余维补 0', () => {
    const radar = radarFromStageScore(
      stageScoreOf({
        objective: [{ dim: 'task', score: 4, source: 'judge', weight: 1 }],
      }),
    );
    expect(radar).toEqual(radarOf({ task: 4 }, 0));
  });

  it('objective 全为 craft 维（非通用六维）→ null', () => {
    const radar = radarFromStageScore(
      stageScoreOf({
        objective: [
          { dim: 'code_runnability', score: 4, source: 'judge', weight: 0.5 },
          { dim: 'code_security', score: 3, source: 'judge', weight: 0.5 },
        ],
      }),
    );
    expect(radar).toBeNull();
  });

  it('边界：objective 为空 / 评分卡为 null → null', () => {
    expect(radarFromStageScore(stageScoreOf({ objective: [] }))).toBeNull();
    expect(radarFromStageScore(null)).toBeNull();
    expect(radarFromStageScore(undefined)).toBeNull();
  });
});

describe('radarSource · resolveAgentRadar（★ 三源优先级 → RadarSourceKind）', () => {
  it("★ 源1：有评估档案且六维有效 → 'evaluation'（置信度 1）", () => {
    const result = resolveAgentRadar({ profile: profileWith(radarOf({}, 4)) });
    expect(result.source).toBe('evaluation');
    expect(result.radar).toEqual(radarOf({}, 4));
    expect(result.confidence).toBe(1);
  });

  it("★ 源1 优先于源2：同时有评估档案与 S1 评分卡 → 仍取 'evaluation'", () => {
    const result = resolveAgentRadar({
      profile: profileWith(radarOf({}, 4)),
      stageScores: [stageScoreOf({ stage: 'preScreen', objective: objectiveSix(2) })],
    });
    expect(result.source).toBe('evaluation');
    expect(result.radar?.task).toBe(4);
  });

  it("★ 源2：无评估档案但有 S1 初审评分卡 → 'prescreen'（置信度 0.7）", () => {
    const result = resolveAgentRadar({
      stageScores: [stageScoreOf({ stage: 'preScreen', objective: objectiveSix(3) })],
    });
    expect(result.source).toBe('prescreen');
    expect(result.radar).toEqual(radarOf({}, 3));
    expect(result.confidence).toBe(0.7);
  });

  it("★ 源2：评估档案六维全零（占位档案）→ 降级到 'prescreen'", () => {
    const result = resolveAgentRadar({
      profile: profileWith(radarOf({}, 0)),
      stageScores: [stageScoreOf({ stage: 'preScreen', objective: objectiveSix(3) })],
    });
    expect(result.source).toBe('prescreen');
  });

  it("★ 源2 只认 preScreen 阶段：仅有 interview 评分卡时不作为六维来源", () => {
    const result = resolveAgentRadar({
      stageScores: [stageScoreOf({ stage: 'interview', objective: objectiveSix(3) })],
    });
    expect(result.source).toBe('none');
    expect(result.radar).toBeNull();
  });

  it("★ 源3：开启 allowHeuristic 且有种子 → 'heuristic'（置信度 0.4）", () => {
    const result = resolveAgentRadar({
      heuristic: { name: '设计助手', description: '海报设计', rating: 4 },
      allowHeuristic: true,
    });
    expect(result.source).toBe('heuristic');
    expect(result.radar).not.toBeNull();
    expect(result.confidence).toBe(0.4);
  });

  it("★ 源3 默认关闭：有种子但未开启 allowHeuristic → 'none'", () => {
    const result = resolveAgentRadar({ heuristic: { name: '设计助手', rating: 4 } });
    expect(result.source).toBe('none');
    expect(result.radar).toBeNull();
  });

  it("★ 源3：开启 allowHeuristic 但无种子 → 'none'", () => {
    const result = resolveAgentRadar({ allowHeuristic: true });
    expect(result.source).toBe('none');
  });

  it("★ 源4：三源皆无 → 'none' 且 radar 为 null（卡片显示「S1 初审」按钮）", () => {
    const result = resolveAgentRadar({});
    expect(result.source).toBe('none');
    expect(result.radar).toBeNull();
    expect(result.stageScoreTotal).toBeUndefined();
    expect(result.verdict).toBeUndefined();
  });

  it('S3 绩效回流：任何来源下都补齐 stageScoreTotal / verdict', () => {
    const perf = stageScoreOf({
      stage: 'performance',
      total: 88,
      verdict: 'MVP',
      ts: '2026-07-20T00:00:00Z',
    });

    const fromEvaluation = resolveAgentRadar({
      profile: profileWith(radarOf({}, 4)),
      stageScores: [perf],
    });
    expect(fromEvaluation.source).toBe('evaluation');
    expect(fromEvaluation.stageScoreTotal).toBe(88);
    expect(fromEvaluation.verdict).toBe('MVP');

    const fromNone = resolveAgentRadar({ stageScores: [perf] });
    expect(fromNone.source).toBe('none');
    expect(fromNone.stageScoreTotal).toBe(88);
    expect(fromNone.verdict).toBe('MVP');
  });

  it('S3 绩效取最新一张 performance 评分卡', () => {
    const result = resolveAgentRadar({
      stageScores: [
        stageScoreOf({ stage: 'performance', total: 50, ts: '2026-07-01T00:00:00Z' }),
        stageScoreOf({ stage: 'performance', total: 91, ts: '2026-07-15T00:00:00Z' }),
      ],
    });
    expect(result.stageScoreTotal).toBe(91);
  });

  it('返回值恒包含 source 字段，且为四种合法枚举之一', () => {
    const inputs = [
      {},
      { profile: profileWith(radarOf({}, 4)) },
      { stageScores: [stageScoreOf({ objective: objectiveSix(3) })] },
      { heuristic: {} as HeuristicSeed, allowHeuristic: true },
    ];
    for (const input of inputs) {
      const kind = resolveAgentRadar(input).source;
      expect(['evaluation', 'prescreen', 'heuristic', 'none']).toContain(kind);
    }
  });
});

describe('radarSource · heuristicRadar（启发式种子）', () => {
  it('确定性：同一种子多次调用结果恒等（无随机）', () => {
    const seed: HeuristicSeed = {
      name: '设计助手',
      description: '擅长海报与品牌视觉设计',
      tags: ['设计', '创意', '海报'],
      rating: 4.5,
      budgetNum: 199,
      hiredCount: 120,
    };
    expect(heuristicRadar(seed)).toEqual(heuristicRadar(seed));
  });

  it('quality 由市场评分驱动：rating×0.9+0.4', () => {
    // 4×0.9+0.4 = 4.0
    expect(heuristicRadar({ rating: 4 }).quality).toBe(4);
    // 2×0.9+0.4 = 2.2 → 对齐 0.5 步进 → 2.0
    expect(heuristicRadar({ rating: 2 }).quality).toBe(2);
  });

  it('cost 按报价分档：免费最高，越贵越低（单调不增）', () => {
    const budgets = [0, 99, 299, 599, 999, 5000];
    const costs = budgets.map((budgetNum) => heuristicRadar({ budgetNum }).cost);
    expect(costs[0]).toBe(5);
    expect(costs[costs.length - 1]).toBe(2.5);
    for (let i = 1; i < costs.length; i += 1) {
      expect(costs[i]).toBeLessThanOrEqual(costs[i - 1]);
    }
  });

  it('task：团队形态与能力条目数带来加成', () => {
    const single = heuristicRadar({ hireType: 'single' }).task;
    const team = heuristicRadar({ hireType: 'team', capabilityCount: 5 }).task;
    expect(team).toBeGreaterThan(single);
  });

  it('creativity：命中创作类信号显著加成', () => {
    const plain = heuristicRadar({ description: '处理表格' }).creativity;
    const creative = heuristicRadar({ description: '创意设计与品牌视觉', tags: ['海报'] }).creativity;
    expect(creative).toBeGreaterThan(plain);
  });

  it('reliability：已雇佣数越多越高（社会验证分档）', () => {
    const low = heuristicRadar({ hiredCount: 0 }).reliability;
    const mid = heuristicRadar({ hiredCount: 100 }).reliability;
    const high = heuristicRadar({ hiredCount: 2000 }).reliability;
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
  });

  it('comm：简介越充分、标签越多，沟通信号越强', () => {
    const thin = heuristicRadar({ description: '短' }).comm;
    const rich = heuristicRadar({
      description: '这是一段足够长的能力简介'.repeat(5),
      tags: ['沟通', '文档', '协作'],
    }).comm;
    expect(rich).toBeGreaterThan(thin);
  });

  it('空种子也返回合法六维：全部落在 [0,5] 且对齐 0.5 步进', () => {
    const radar = heuristicRadar({});
    for (const value of Object.values(radar)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(5);
      expect(value * 2).toBe(Math.round(value * 2));
    }
  });
});
