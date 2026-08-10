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
