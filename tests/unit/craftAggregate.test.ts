/**
 * tests/unit/craftAggregate.test.ts
 * craft 客观分聚合的行为约束。
 *
 * 核心不变量：未评测的轮次绝不产生分数 —— 这正是「同题同 rubric」客观性的底线，
 * 一旦 judge 不可用被补成 0 分，个人上传的 agent 又会被系统性压分。
 */
import { describe, expect, it } from 'vitest';

import {
  aggregateCraftDims,
  buildCraftEvidence,
  buildVerifiedEvidence,
  summarizeSandbox,
  toHalfStep,
} from '@/engine/interview/craftAggregate';
import type { CraftJudgement } from '@/types/craft';
import type { CraftTrialRound } from '@/types/interview';

function judgement(over: Partial<CraftJudgement> = {}): CraftJudgement {
  return {
    task_id: 'code_csv_merge',
    job_type: 'code',
    dims: { code_runnability: 4 },
    unscored_dims: [],
    checkpoints: [],
    padding_detected: false,
    padding_note: '',
    confidence: 0.8,
    reference_used: false,
    ttft_ms: 120,
    latency_ms: 900,
    backend: 'minicpm-o',
    ...over,
  };
}

function trial(over: Partial<CraftTrialRound> = {}): CraftTrialRound {
  return {
    taskId: 'code_csv_merge',
    title: '合并订单 CSV',
    prompt: '实现 merge_orders(path_a, path_b)',
    answerText: 'def merge_orders(...)',
    mode: 'agent',
    answerLatencyMs: 900,
    judgement: judgement(),
    ts: '2026-08-09T00:00:00.000Z',
    ...over,
  };
}

describe('toHalfStep', () => {
  it('对齐 0.5 步进并夹到 0–5', () => {
    expect(toHalfStep(3.24)).toBe(3);
    expect(toHalfStep(3.26)).toBe(3.5);
    expect(toHalfStep(-1)).toBe(0);
    expect(toHalfStep(9)).toBe(5);
  });
});

describe('aggregateCraftDims', () => {
  it('同一维被多题考到时取均值并对齐半分', () => {
    const result = aggregateCraftDims([
      trial({ taskId: 't1', judgement: judgement({ dims: { code_runnability: 4 } }) }),
      trial({ taskId: 't2', judgement: judgement({ dims: { code_runnability: 3 } }) }),
    ]);
    expect(result.dims.code_runnability).toBe(3.5);
    expect(result.judgedCount).toBe(2);
  });

  it('judge 不可用的轮次不产生任何分数', () => {
    const result = aggregateCraftDims([
      trial({ taskId: 't1', judgement: null, judgeError: 'model-service unreachable' }),
    ]);
    expect(result.dims).toEqual({});
    expect(result.judgedCount).toBe(0);
    expect(result.trialCount).toBe(1);
    expect(result.avgConfidence).toBeNull();
  });

  it('某题未覆盖但另一题评上分的维，不算 unscored', () => {
    const result = aggregateCraftDims([
      trial({
        taskId: 't1',
        judgement: judgement({
          dims: { code_runnability: 4 },
          unscored_dims: ['code_security', 'code_efficiency'],
        }),
      }),
      trial({
        taskId: 't2',
        judgement: judgement({ dims: { code_security: 3 }, unscored_dims: [] }),
      }),
    ]);
    expect(result.dims.code_security).toBe(3);
    expect(result.unscored).toEqual(['code_efficiency']);
  });

  it('统计注水轮数但不在前端二次压分', () => {
    const result = aggregateCraftDims([
      trial({
        taskId: 't1',
        judgement: judgement({ dims: { code_runnability: 2 }, padding_detected: true }),
      }),
    ]);
    expect(result.paddingCount).toBe(1);
    expect(result.dims.code_runnability).toBe(2);
  });
});

describe('buildCraftEvidence', () => {
  it('只收命中且有引文的 checkpoint', () => {
    const evidence = buildCraftEvidence([
      trial({
        judgement: judgement({
          dims: { code_runnability: 4 },
          checkpoints: [
            { checkpoint: '处理了文件缺失', hit: true, quote: 'if not os.path.exists' },
            { checkpoint: '给出了测试用例', hit: false, quote: '' },
            { checkpoint: '声称已测试', hit: true, quote: '   ' },
          ],
        }),
      }),
    ]);
    expect(evidence.code_runnability).toContain('if not os.path.exists');
    expect(evidence.code_runnability).not.toContain('给出了测试用例');
  });

  it('未评测的轮次不产生证据', () => {
    expect(buildCraftEvidence([trial({ judgement: null })])).toEqual({});
  });
});

/**
 * 机器可核验证据（沙盒真实执行）与裁判引文的分离。
 *
 * 这组用例守的是整套评测最重要的一条界线：能解除 code_runnability 权重折减的，
 * 只能是「代码真的跑过」这个事实，而不能是裁判模型说了句好话。
 */
describe('buildVerifiedEvidence / summarizeSandbox', () => {
  function sandbox(over: Partial<NonNullable<CraftJudgement['sandbox']>> = {}) {
    return {
      outcome: 'passed' as const,
      total: 4,
      passed: 4,
      failed: 0,
      durationMs: 210,
      cases: [{ name: 'test_merge', passed: true, detail: '' }],
      outputTail: '',
      reason: '',
      codeBytes: 320,
      verifiable: true,
      evidence: '沙盒执行：4/4 用例通过（210ms）',
      ...over,
    };
  }

  it('只有真实执行结果进入 verifiedEvidence，裁判引文不得混入', () => {
    const trials = [
      trial({
        judgement: judgement({
          checkpoints: [{ checkpoint: '代码可直接运行', hit: true, quote: '「代码可直接运行」' }],
          verified_evidence: { code_runnability: '[code_csv_merge] 沙盒执行：4/4 用例通过（210ms）' },
          sandbox: sandbox(),
        }),
      }),
    ];
    const verified = buildVerifiedEvidence(trials);
    const quoted = buildCraftEvidence(trials);

    expect(verified.code_runnability).toContain('4/4 用例通过');
    // 裁判引文只出现在展示用证据里，绝不出现在可解除降权的字段里
    expect(quoted.code_runnability).toContain('代码可直接运行');
    expect(verified.code_runnability).not.toContain('代码可直接运行');
  });

  it('裁判说得再好听，没有真实执行就没有 verifiedEvidence', () => {
    const trials = [
      trial({
        judgement: judgement({
          checkpoints: [
            { checkpoint: '代码可直接运行，无未定义名称', hit: true, quote: '「已充分测试」' },
          ],
          // 后端未产出 verified_evidence（沙盒未启用 / 没写测试 / 没抽到代码）
          sandbox: sandbox({ outcome: 'no_tests', total: 0, passed: 0, verifiable: false }),
        }),
      }),
    ];
    expect(buildVerifiedEvidence(trials)).toEqual({});
  });

  it('失败的执行同样是已验证的事实（关于可运行性我们确实测到了结论）', () => {
    const trials = [
      trial({
        judgement: judgement({
          verified_evidence: {
            code_runnability: '[code_csv_merge] 沙盒执行：1/3 用例通过，2 个失败（180ms）',
          },
          sandbox: sandbox({ outcome: 'failed', total: 3, passed: 1, failed: 2 }),
        }),
      }),
    ];
    expect(buildVerifiedEvidence(trials).code_runnability).toContain('2 个失败');
  });

  it('多题验证同一维时全部保留（每条都是独立可复核的事实）', () => {
    const trials = [
      trial({
        taskId: 'code_csv_merge',
        judgement: judgement({ verified_evidence: { code_runnability: 'A：2/2 通过' } }),
      }),
      trial({
        taskId: 'code_debug_race',
        judgement: judgement({ verified_evidence: { code_runnability: 'B：3/3 通过' } }),
      }),
    ];
    const verified = buildVerifiedEvidence(trials);
    expect(verified.code_runnability).toContain('A：2/2 通过');
    expect(verified.code_runnability).toContain('B：3/3 通过');
  });

  it('summarizeSandbox 区分「没写用例」与「用例没过」', () => {
    const trials = [
      trial({ taskId: 't1', judgement: judgement({ sandbox: sandbox() }) }),
      trial({
        taskId: 't2',
        judgement: judgement({
          sandbox: sandbox({ outcome: 'failed', total: 2, passed: 1, failed: 1 }),
        }),
      }),
      trial({
        taskId: 't3',
        judgement: judgement({
          sandbox: sandbox({ outcome: 'no_tests', total: 0, passed: 0, verifiable: false }),
        }),
      }),
    ];
    const s = summarizeSandbox(trials);
    expect(s.verifiedTasks).toBe(2);
    expect(s.passedTasks).toBe(1);
    expect(s.failedTasks).toBe(1);
    // 「没写用例」不计入验证过的题，也不算失败
    expect(s.noTestTasks).toBe(1);
    expect(s.passedCases).toBe(5);
    expect(s.totalCases).toBe(6);
  });

  it('未评测轮次不参与任何统计', () => {
    const s = summarizeSandbox([trial({ judgement: null })]);
    expect(s).toEqual({
      verifiedTasks: 0,
      passedTasks: 0,
      failedTasks: 0,
      noTestTasks: 0,
      totalCases: 0,
      passedCases: 0,
    });
  });
});
