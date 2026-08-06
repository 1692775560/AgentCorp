/**
 * tests/unit/dimTracker.test.ts
 *
 * 维度证据追踪与追问建议引擎单测（模块 B · 设计 §5.3 / §3.2）：
 *  - evidenceStrength   —— 单条回答证据强度（长度/结构化/具体性/取舍四类信号）
 *  - computeCoverage    —— 逐轮聚合各维 asked/answered/strength/coverage/rating
 *  - coverageRatio      —— 全场覆盖比
 *  - suggestFollowups   —— ★ 追问建议优先最薄弱维度
 *  - buildMetrics / buildDimEvidence / aggregateHrRadar / recommendationOf
 *
 * 测试重点：给定若干 turn 的证据，断言覆盖度聚合正确、追问建议优先薄弱维度。
 * 运行：env -u NODE_OPTIONS npx vitest run tests/unit/dimTracker.test.ts
 */
import { describe, it, expect } from 'vitest';
import type { CraftDim, RadarDim, RadarScore } from '@/types/evaluation';
import type { InterviewTurn } from '@/types/interview';
import {
  CRAFT_DIM_LABELS,
  aggregateHrRadar,
  averageLatency,
  buildDimEvidence,
  buildMetrics,
  computeCoverage,
  countClarifications,
  countFollowups,
  coverageRatio,
  dimLabel,
  evidenceStrength,
  isClarification,
  isFollowupTurn,
  recommendationOf,
  suggestFollowups,
  totalTokens,
} from '@/engine/interview/dimTracker';

/**
 * 强证据回答（205 字符，命中全部四类信号）→ 证据强度满分 1。
 * 长度 >= 200 是满分的必要条件，故在用例中显式守卫，避免文案微调导致静默失效。
 */
const RICH_REPLY = [
  '1. 首先明确交付物边界，例如接口契约（API schema）与字段格式，以及可验收的标准；',
  '2. 然后设计三类测试：单元测试、集成测试、回归测试，分支覆盖率目标 80% 以上，关键路径必须全部覆盖；',
  '3. 如果线上与本地行为不一致，则先回滚再定位，评估代价与风险之后再决定是否重新发布上线；',
  '4. 交付前我会给出一份检查清单，逐项勾选并标注最容易翻车的一项，涉及并发场景下的幂等处理，需要你逐条确认预期行为。',
].join('\n');

/** 弱证据回答（25 字符纯中文口号，仅命中长度分）→ 0.15 */
const THIN_REPLY = '我会认真完成这个任务并且保证交付质量达到客户的要求';

/** 构造一轮问答 */
function turnOf(over: Partial<InterviewTurn> & Pick<InterviewTurn, 'turn' | 'targetDims'>): InterviewTurn {
  return {
    qId: `q${over.turn}`,
    question: '题干',
    replyText: '',
    replyLatencyMs: null,
    tokensUsed: null,
    hrRatings: {},
    ts: '2026-07-30T00:00:00Z',
    ...over,
  };
}

describe('dimTracker · evidenceStrength（证据强度）', () => {
  it('★ 空回答 / 纯空白 → 0', () => {
    expect(evidenceStrength('')).toBe(0);
    expect(evidenceStrength('   ')).toBe(0);
    expect(evidenceStrength('\n\n')).toBe(0);
  });

  it('★ 极短口水话（无任何信号）→ 0', () => {
    expect(evidenceStrength('还行吧')).toBe(0);
    expect(evidenceStrength('好的')).toBe(0);
  });

  it('★ 20 字以上纯中文口号 → 仅得长度分 0.15', () => {
    expect(THIN_REPLY.length).toBeGreaterThanOrEqual(20);
    expect(THIN_REPLY.length).toBeLessThan(80);
    expect(evidenceStrength(THIN_REPLY)).toBeCloseTo(0.15, 10);
  });

  it('★ 追加取舍语（如果）→ 额外 +0.15', () => {
    expect(evidenceStrength(`${THIN_REPLY}，如果不行就调整`)).toBeCloseTo(0.3, 10);
  });

  it('★ 结构化 + 具体 + 取舍的长回答 → 满分 1（并夹取上限）', () => {
    expect(RICH_REPLY.length).toBeGreaterThanOrEqual(200);
    expect(evidenceStrength(RICH_REPLY)).toBe(1);
  });

  it('信号越多强度越高（单调性）', () => {
    expect(evidenceStrength(RICH_REPLY)).toBeGreaterThan(evidenceStrength(THIN_REPLY));
    expect(evidenceStrength(THIN_REPLY)).toBeGreaterThan(evidenceStrength('还行吧'));
  });

  it('结果恒在 [0,1] 且确定性（同输入同输出）', () => {
    for (const text of ['', '还行吧', THIN_REPLY, RICH_REPLY]) {
      const s = evidenceStrength(text);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
      expect(s).toBe(evidenceStrength(text));
    }
  });
});

describe('dimTracker · isClarification / isFollowupTurn', () => {
  it('包含问号 → 主动澄清', () => {
    expect(isClarification('交付格式是 PNG 还是 SVG？')).toBe(true);
    expect(isClarification('Is it PNG or SVG?')).toBe(true);
  });

  it('显式声明假设 → 主动澄清', () => {
    expect(isClarification('我先假设使用 JSON 格式')).toBe(true);
    expect(isClarification('前提是数据已经清洗过')).toBe(true);
    expect(isClarification('这里需要你确认一下')).toBe(true);
  });

  it('平铺直叙 / 空回答 → 非澄清', () => {
    expect(isClarification('好的，我这就开始做')).toBe(false);
    expect(isClarification('')).toBe(false);
  });

  it('qId 带 :fu 后缀 → 追问轮', () => {
    expect(isFollowupTurn(turnOf({ turn: 1, targetDims: [], qId: 'p1_restate:fu1' }))).toBe(true);
    expect(isFollowupTurn(turnOf({ turn: 1, targetDims: [], qId: 'p1_restate' }))).toBe(false);
  });
});

describe('dimTracker · dimLabel（维度标签）', () => {
  it('通用六维与 craft 维都能取到中文标签', () => {
    expect(dimLabel('task')).toBe('任务');
    expect(dimLabel('cost')).toBe('性价比');
    expect(dimLabel('code_runnability')).toBe(CRAFT_DIM_LABELS.code_runnability);
    expect(dimLabel('img_composition')).toBe('构图');
  });

  it('未知维度回退为原始 key（不抛异常）', () => {
    expect(dimLabel('unknown_dim')).toBe('unknown_dim');
  });
});

describe('dimTracker · computeCoverage（★ 逐维证据聚合）', () => {
  // T1 强证据命中 task/comm；T2 提问了 quality 但无回答；T3 弱证据命中 reliability；cost 从未提问
  const turns: InterviewTurn[] = [
    turnOf({
      turn: 1,
      targetDims: ['task', 'comm'],
      replyText: RICH_REPLY,
      hrRatings: { task: 4 },
    }),
    turnOf({ turn: 2, targetDims: ['quality'], replyText: '' }),
    turnOf({ turn: 3, targetDims: ['reliability'], replyText: THIN_REPLY }),
  ];
  const targetDims: (RadarDim | CraftDim)[] = [
    'task',
    'comm',
    'quality',
    'reliability',
    'cost',
  ];

  it('★ 强证据维：asked/answered = 1，coverage 达到 1', () => {
    const coverage = computeCoverage(turns, targetDims);
    const task = coverage.find((c) => c.dim === 'task')!;
    expect(task.asked).toBe(1);
    expect(task.answered).toBe(1);
    expect(task.strength).toBeCloseTo(1, 10);
    expect(task.coverage).toBeCloseTo(1, 10);
  });

  it('★ 已提问但无有效回答：asked=1、answered=0、coverage=0', () => {
    const quality = computeCoverage(turns, targetDims).find((c) => c.dim === 'quality')!;
    expect(quality.asked).toBe(1);
    expect(quality.answered).toBe(0);
    expect(quality.coverage).toBe(0);
  });

  it('★ 弱证据维：coverage 等于证据强度（0.15）', () => {
    const reliability = computeCoverage(turns, targetDims).find((c) => c.dim === 'reliability')!;
    expect(reliability.answered).toBe(1);
    expect(reliability.coverage).toBeCloseTo(0.15, 10);
  });

  it('★ 从未提问的维：asked=0、coverage=0（零证据）', () => {
    const cost = computeCoverage(turns, targetDims).find((c) => c.dim === 'cost')!;
    expect(cost.asked).toBe(0);
    expect(cost.answered).toBe(0);
    expect(cost.coverage).toBe(0);
  });

  it('多轮命中同一维时证据累加，并夹取到 1', () => {
    const repeated = [
      turnOf({ turn: 1, targetDims: ['task'], replyText: THIN_REPLY }),
      turnOf({ turn: 2, targetDims: ['task'], replyText: THIN_REPLY }),
    ];
    const task = computeCoverage(repeated, ['task'])[0];
    expect(task.asked).toBe(2);
    expect(task.answered).toBe(2);
    expect(task.strength).toBeCloseTo(0.3, 10);
    expect(task.coverage).toBeCloseTo(0.3, 10);

    const saturated = computeCoverage(
      [
        turnOf({ turn: 1, targetDims: ['task'], replyText: RICH_REPLY }),
        turnOf({ turn: 2, targetDims: ['task'], replyText: RICH_REPLY }),
      ],
      ['task'],
    )[0];
    expect(saturated.strength).toBeCloseTo(2, 10);
    expect(saturated.coverage).toBe(1);
  });

  it('HR 评分回填到对应维（craft 维恒为 null）', () => {
    const coverage = computeCoverage(turns, [...targetDims, 'code_runnability']);
    expect(coverage.find((c) => c.dim === 'task')!.rating).toBe(4);
    expect(coverage.find((c) => c.dim === 'comm')!.rating).toBeNull();
    expect(coverage.find((c) => c.dim === 'code_runnability')!.rating).toBeNull();
  });

  it('同一维多次打分取最近一次', () => {
    const rated = [
      turnOf({ turn: 1, targetDims: ['task'], replyText: THIN_REPLY, hrRatings: { task: 2 } }),
      turnOf({ turn: 2, targetDims: ['task'], replyText: THIN_REPLY, hrRatings: { task: 5 } }),
    ];
    expect(computeCoverage(rated, ['task'])[0].rating).toBe(5);
  });

  it('输出顺序与 targetDims 一致，且逐项都有中文标签', () => {
    const coverage = computeCoverage(turns, targetDims);
    expect(coverage.map((c) => c.dim)).toEqual(targetDims);
    for (const item of coverage) expect(item.label.length).toBeGreaterThan(0);
  });

  it('边界：无轮次 → 全维零覆盖；无 targetDims → 空数组', () => {
    for (const item of computeCoverage([], targetDims)) {
      expect(item.asked).toBe(0);
      expect(item.coverage).toBe(0);
    }
    expect(computeCoverage(turns, [])).toEqual([]);
  });

  it('★ coverageRatio：全场覆盖比 = 各维覆盖度均值', () => {
    // (1 + 1 + 0 + 0.15 + 0) / 5 = 0.43
    expect(coverageRatio(computeCoverage(turns, targetDims))).toBeCloseTo(0.43, 10);
  });

  it('coverageRatio：空覆盖表 → 0；全满 → 1', () => {
    expect(coverageRatio([])).toBe(0);
    const full = computeCoverage(
      [turnOf({ turn: 1, targetDims: ['task', 'comm'], replyText: RICH_REPLY })],
      ['task', 'comm'],
    );
    expect(coverageRatio(full)).toBeCloseTo(1, 10);
  });
});

describe('dimTracker · suggestFollowups（★ 优先最薄弱维度）', () => {
  const turns: InterviewTurn[] = [
    turnOf({ turn: 1, targetDims: ['task', 'comm'], replyText: RICH_REPLY }),
    turnOf({ turn: 2, targetDims: ['quality'], replyText: '' }),
    turnOf({ turn: 3, targetDims: ['reliability'], replyText: THIN_REPLY }),
  ];
  const targetDims: (RadarDim | CraftDim)[] = [
    'task',
    'comm',
    'quality',
    'reliability',
    'cost',
  ];

  it('★ 建议顺序严格按覆盖度升序（最薄弱优先），零证据维排最前', () => {
    const suggestions = suggestFollowups(turns, targetDims);
    // cost（未提问，coverage 0，asked 0） → quality（已问未答，coverage 0，asked 1） → reliability（0.15）
    expect(suggestions.map((s) => s.dim)).toEqual(['cost', 'quality', 'reliability']);
  });

  it('★ 已充分覆盖（coverage >= 0.8）的维度不出现在建议中', () => {
    const dims = suggestFollowups(turns, targetDims).map((s) => s.dim);
    expect(dims).not.toContain('task');
    expect(dims).not.toContain('comm');
  });

  it('★ 三类薄弱原因分别给出可解释文案', () => {
    const suggestions = suggestFollowups(turns, targetDims);
    expect(suggestions.find((s) => s.dim === 'cost')!.reason).toBe('尚未提问，零证据');
    expect(suggestions.find((s) => s.dim === 'quality')!.reason).toBe('已提问但未获得有效回答');
    expect(suggestions.find((s) => s.dim === 'reliability')!.reason).toContain('证据偏薄');
    expect(suggestions.find((s) => s.dim === 'reliability')!.reason).toContain('15%');
  });

  it('每条建议都带可直接发送的追问题干与中文标签', () => {
    for (const s of suggestFollowups(turns, targetDims)) {
      expect(s.prompt.length).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it('未知维度回退到通用追问模板（不抛异常）', () => {
    const suggestions = suggestFollowups([], ['unknown_dim' as CraftDim]);
    expect(suggestions[0].prompt).toContain('请再具体一点');
  });

  it('默认最多返回 3 条，可通过 max 覆盖（需同步下调 min，二者语义互斥）', () => {
    expect(suggestFollowups(turns, targetDims).length).toBeLessThanOrEqual(3);
    expect(suggestFollowups(turns, targetDims, { max: 1, min: 1 })).toHaveLength(1);
  });

  it('min 是「保底条数」下限：max < min 时以 min 为准（保证 HR 始终有可点追问）', () => {
    // 语义约定：max 限制「薄弱维筛选结果」的条数，min 是最终输出的保底条数。
    // 仅传 max=1 而 min 仍为默认 2 时，筛选结果不足 min → 回退到最薄弱的 min 条。
    expect(suggestFollowups(turns, targetDims, { max: 1 })).toHaveLength(2);
  });

  it('★ 即使全部维度均已达标，也保留最薄弱的 min 条（HR 始终有可点追问）', () => {
    const allCovered = [
      turnOf({ turn: 1, targetDims: ['task', 'comm'], replyText: RICH_REPLY }),
    ];
    const suggestions = suggestFollowups(allCovered, ['task', 'comm']);
    expect(suggestions).toHaveLength(2);
  });

  it('threshold 可调：调高后更多维度被判定为需要追问', () => {
    const strict = suggestFollowups(turns, targetDims, { threshold: 1.01, max: 10 });
    const loose = suggestFollowups(turns, targetDims, { threshold: 0.1, max: 10 });
    expect(strict.length).toBeGreaterThan(loose.length);
  });

  it('边界：无轮次 → 按 targetDims 顺序给出零证据建议', () => {
    const suggestions = suggestFollowups([], ['task', 'quality', 'cost']);
    expect(suggestions).toHaveLength(3);
    for (const s of suggestions) expect(s.reason).toBe('尚未提问，零证据');
  });

  it('边界：无 targetDims → 空建议', () => {
    expect(suggestFollowups(turns, [])).toEqual([]);
  });
});

describe('dimTracker · 指标聚合', () => {
  it('countClarifications：统计主动澄清轮数', () => {
    const turns = [
      turnOf({ turn: 1, targetDims: [], replyText: '交付格式是 PNG 还是 SVG？' }),
      turnOf({ turn: 2, targetDims: [], replyText: '我先假设用 JSON' }),
      turnOf({ turn: 3, targetDims: [], replyText: '好的，这就做' }),
    ];
    expect(countClarifications(turns)).toBe(2);
    expect(countClarifications([])).toBe(0);
  });

  it('countFollowups：统计追问轮数', () => {
    const turns = [
      turnOf({ turn: 1, targetDims: [], qId: 'p1_restate' }),
      turnOf({ turn: 2, targetDims: [], qId: 'p1_restate:fu1' }),
      turnOf({ turn: 3, targetDims: [], qId: 'p1_restate:fu2' }),
    ];
    expect(countFollowups(turns)).toBe(2);
    expect(countFollowups([])).toBe(0);
  });

  it('averageLatency：忽略 null 与非正值，四舍五入取整', () => {
    const turns = [
      turnOf({ turn: 1, targetDims: [], replyLatencyMs: 1200 }),
      turnOf({ turn: 2, targetDims: [], replyLatencyMs: 800 }),
      turnOf({ turn: 3, targetDims: [], replyLatencyMs: null }),
    ];
    expect(averageLatency(turns)).toBe(1000);
  });

  it('averageLatency：全部手动模式（全 null）→ null', () => {
    expect(averageLatency([turnOf({ turn: 1, targetDims: [], replyLatencyMs: null })])).toBeNull();
    expect(averageLatency([])).toBeNull();
  });

  it('totalTokens：累加可得值；全不可得 → null', () => {
    const turns = [
      turnOf({ turn: 1, targetDims: [], tokensUsed: 100 }),
      turnOf({ turn: 2, targetDims: [], tokensUsed: 200 }),
      turnOf({ turn: 3, targetDims: [], tokensUsed: null }),
    ];
    expect(totalTokens(turns)).toBe(300);
    expect(totalTokens([turnOf({ turn: 1, targetDims: [], tokensUsed: null })])).toBeNull();
    expect(totalTokens([])).toBeNull();
  });

  it('★ buildMetrics：一次性汇总五项面试指标', () => {
    const turns = [
      turnOf({
        turn: 1,
        targetDims: ['task', 'comm'],
        qId: 'p1_restate',
        replyText: RICH_REPLY,
        replyLatencyMs: 1000,
        tokensUsed: 500,
      }),
      turnOf({
        turn: 2,
        targetDims: ['quality'],
        qId: 'p1_restate:fu1',
        replyText: '这里想跟你确认一下验收标准？',
        replyLatencyMs: 2000,
        tokensUsed: 300,
      }),
    ];
    const metrics = buildMetrics(turns, ['task', 'comm', 'quality', 'cost']);
    expect(metrics.avgReplyLatencyMs).toBe(1500);
    expect(metrics.totalTokens).toBe(800);
    expect(metrics.clarificationCount).toBe(1);
    expect(metrics.followupCount).toBe(1);
    expect(metrics.coverageRatio).toBeGreaterThan(0);
    expect(metrics.coverageRatio).toBeLessThanOrEqual(1);
  });

  it('buildMetrics：零轮次 → 全空指标', () => {
    const metrics = buildMetrics([], ['task']);
    expect(metrics.avgReplyLatencyMs).toBeNull();
    expect(metrics.totalTokens).toBeNull();
    expect(metrics.clarificationCount).toBe(0);
    expect(metrics.followupCount).toBe(0);
    expect(metrics.coverageRatio).toBe(0);
  });
});

describe('dimTracker · buildDimEvidence（逐维证据文本）', () => {
  it('按维度聚合证据，并带轮次前缀', () => {
    const turns = [
      turnOf({ turn: 1, targetDims: ['task', 'comm'], replyText: '回答一' }),
      turnOf({ turn: 2, targetDims: ['task'], replyText: '回答二' }),
    ];
    const evidence = buildDimEvidence(turns);
    expect(evidence.task).toEqual(['T1｜回答一', 'T2｜回答二']);
    expect(evidence.comm).toEqual(['T1｜回答一']);
  });

  it('HR 证据备注优先于回答原文', () => {
    const turns = [
      turnOf({
        turn: 1,
        targetDims: ['task'],
        replyText: '原始回答',
        evidenceNote: 'HR 标注要点',
      }),
    ];
    expect(buildDimEvidence(turns).task).toEqual(['T1｜HR 标注要点']);
  });

  it('回答过长时截断到 120 字', () => {
    const evidence = buildDimEvidence([
      turnOf({ turn: 1, targetDims: ['task'], replyText: RICH_REPLY }),
    ]);
    // 前缀 'T1｜' 3 字符 + 截断后正文 120 字符
    expect(evidence.task![0].length).toBe(123);
  });

  it('空回答且无备注的轮次被跳过', () => {
    const evidence = buildDimEvidence([
      turnOf({ turn: 1, targetDims: ['task'], replyText: '   ' }),
    ]);
    expect(evidence.task).toBeUndefined();
  });

  it('零轮次 → 空对象', () => {
    expect(buildDimEvidence([])).toEqual({});
  });
});

describe('dimTracker · aggregateHrRadar（HR 评分 → 六维）', () => {
  it('单维打分：该维取均值，其余维回落 0（无基线）', () => {
    const radar = aggregateHrRadar([
      turnOf({ turn: 1, targetDims: ['task'], hrRatings: { task: 4 } }),
    ]);
    expect(radar).not.toBeNull();
    expect(radar!.task).toBe(4);
    expect(radar!.quality).toBe(0);
  });

  it('未打分维回落到入场基线', () => {
    const baseline: RadarScore = {
      task: 3,
      quality: 3,
      comm: 3,
      creativity: 3,
      reliability: 3,
      cost: 3,
    };
    const radar = aggregateHrRadar(
      [turnOf({ turn: 1, targetDims: ['task'], hrRatings: { task: 5 } })],
      baseline,
    );
    expect(radar!.task).toBe(5);
    expect(radar!.quality).toBe(3);
  });

  it('多轮同维打分取均值并对齐 0.5 步进', () => {
    const radar = aggregateHrRadar([
      turnOf({ turn: 1, targetDims: ['task'], hrRatings: { task: 4 } }),
      turnOf({ turn: 2, targetDims: ['task'], hrRatings: { task: 3 } }),
    ]);
    expect(radar!.task).toBe(3.5);
  });

  it('★ craft 维证据经 CRAFT_LINKS 以半权回灌关联六维', () => {
    // code_runnability → ['task','reliability']；打分维 task 与自身相同时跳过，
    // reliability 以 0.5 权重回灌 → 2/0.5 = 4
    const radar = aggregateHrRadar([
      turnOf({ turn: 1, targetDims: ['code_runnability'], hrRatings: { task: 4 } }),
    ]);
    expect(radar!.task).toBe(4);
    expect(radar!.reliability).toBe(4);
    expect(radar!.creativity).toBe(0);
  });

  it('无任何 HR 打分 → 返回基线；基线也为空 → null', () => {
    const baseline: RadarScore = {
      task: 2,
      quality: 2,
      comm: 2,
      creativity: 2,
      reliability: 2,
      cost: 2,
    };
    expect(aggregateHrRadar([], baseline)).toEqual(baseline);
    expect(aggregateHrRadar([])).toBeNull();
    expect(aggregateHrRadar([turnOf({ turn: 1, targetDims: ['task'] })])).toBeNull();
  });

  it('输出六维恒落在 [0,5]', () => {
    const radar = aggregateHrRadar([
      turnOf({ turn: 1, targetDims: ['task'], hrRatings: { task: 99 } }),
    ]);
    for (const value of Object.values(radar!)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(5);
    }
  });
});

describe('dimTracker · recommendationOf（HR 结论建议）', () => {
  it('stageScoreTotal 优先：>=75 hire / >=55 hold / 其余 reject', () => {
    expect(recommendationOf(80, null, 0)).toBe('hire');
    expect(recommendationOf(75, null, 0)).toBe('hire');
    expect(recommendationOf(60, null, 0)).toBe('hold');
    expect(recommendationOf(55, null, 0)).toBe('hold');
    expect(recommendationOf(40, null, 0)).toBe('reject');
  });

  it('无 S2 总分时用六维均值 + 覆盖度兜底', () => {
    const strong: RadarScore = {
      task: 4.5,
      quality: 4.5,
      comm: 4.5,
      creativity: 4.5,
      reliability: 4.5,
      cost: 4.5,
    };
    const weak: RadarScore = {
      task: 1,
      quality: 1,
      comm: 1,
      creativity: 1,
      reliability: 1,
      cost: 1,
    };
    expect(recommendationOf(null, strong, 0.7)).toBe('hire');
    // 均值达标但覆盖度不足 → 不轻易 hire，降级为 hold
    expect(recommendationOf(null, strong, 0.3)).toBe('hold');
    expect(recommendationOf(null, weak, 0.9)).toBe('reject');
  });

  it('无任何数据 → hold（保守）', () => {
    expect(recommendationOf(null, null, 0)).toBe('hold');
  });
});
