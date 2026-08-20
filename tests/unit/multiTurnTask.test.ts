/**
 * tests/unit/multiTurnTask.test.ts
 *
 * 多轮交互任务契约单测（借鉴 τ-bench）：
 * - evaluatePolicyCompliance：关键词/正则命中、无违反、空规则
 * - evaluateMultiTurnTask：成功/失败判据
 */
import { describe, it, expect } from 'vitest';
import {
  evaluatePolicyCompliance,
  evaluateMultiTurnTask,
  type MultiTurnTaskSpec,
  type TranscriptTurn,
} from '@/engine/interview/multiTurnTask';

function makeTurn(
  role: 'agent' | 'user',
  content: string,
  turnIndex: number,
): TranscriptTurn {
  return { role, content, turnIndex };
}

describe('evaluatePolicyCompliance', () => {
  it('关键词命中 → 违反', () => {
    const rules = [
      { id: 'no-refund', description: '不得承诺退款', violationKeywords: ['退款', 'refund'] },
    ];
    const transcript = [
      makeTurn('user', '我要退款', 0),
      makeTurn('agent', '好的，我帮您办理退款', 1),
    ];
    const r = evaluatePolicyCompliance(transcript, rules);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].ruleId).toBe('no-refund');
    expect(r.complianceRate).toBe(0);
  });

  it('正则命中 → 违反', () => {
    const rules = [
      { id: 'no-phone', description: '不得透露电话', violationPattern: '\\d{11}' },
    ];
    const transcript = [
      makeTurn('agent', '我的电话是 13800138000', 0),
    ];
    const r = evaluatePolicyCompliance(transcript, rules);
    expect(r.violations).toHaveLength(1);
  });

  it('无违反 → complianceRate=1', () => {
    const rules = [
      { id: 'no-refund', description: '不得承诺退款', violationKeywords: ['退款', 'refund'] },
    ];
    const transcript = [
      makeTurn('agent', '抱歉，根据政策不可办理退回货品，但可以为您换货', 0),
    ];
    const r = evaluatePolicyCompliance(transcript, rules);
    expect(r.violations).toHaveLength(0);
    expect(r.complianceRate).toBe(1);
  });

  it('同一规则多轮命中只记一次', () => {
    const rules = [
      { id: 'no-refund', description: '不得承诺退款', violationKeywords: ['退款'] },
    ];
    const transcript = [
      makeTurn('agent', '可以退款', 0),
      makeTurn('agent', '真的可以退款', 1),
    ];
    const r = evaluatePolicyCompliance(transcript, rules);
    expect(r.violations).toHaveLength(1);
  });

  it('空规则 → complianceRate=1（无约束即全遵守）', () => {
    const r = evaluatePolicyCompliance([makeTurn('agent', '任意', 0)], []);
    expect(r.complianceRate).toBe(1);
    expect(r.violations).toHaveLength(0);
  });

  it('只评估 agent 轮，user 轮不算', () => {
    const rules = [
      { id: 'no-refund', description: '不得承诺退款', violationKeywords: ['退款'] },
    ];
    const transcript = [
      makeTurn('user', '我要退款退款退款', 0),
      makeTurn('agent', '好的', 1),
    ];
    const r = evaluatePolicyCompliance(transcript, rules);
    expect(r.violations).toHaveLength(0);
  });

  it('非法正则被跳过，不算违反', () => {
    const rules = [
      { id: 'bad', description: '坏正则', violationPattern: '[' },
    ];
    const r = evaluatePolicyCompliance([makeTurn('agent', 'x', 0)], rules);
    expect(r.violations).toHaveLength(0);
  });
});

describe('evaluateMultiTurnTask', () => {
  const spec: MultiTurnTaskSpec = {
    id: 'mt-1',
    title: '零售客服多轮',
    jobType: 'text',
    scenario: 'retail',
    taskDescription: '处理退换货咨询',
    policyRules: [
      { id: 'no-refund', description: '不得承诺退款', violationKeywords: ['退款'] },
    ],
    mockUserScript: [
      { turnIndex: 0, userMessage: '我要退货' },
      { turnIndex: 1, userMessage: '那换货呢' },
    ],
    maxTurns: 2,
    successCriteria: '完成 2 轮且不违反 policy',
  };

  it('全遵守 + 轮数达标 → passed=true', () => {
    const transcript = [
      makeTurn('agent', '可以换货', 0),
      makeTurn('agent', '换货流程如下', 1),
    ];
    const r = evaluateMultiTurnTask(transcript, spec);
    expect(r.passed).toBe(true);
    expect(r.compliance.complianceRate).toBe(1);
    expect(r.completedTurns).toBe(2);
  });

  it('违反 policy → passed=false', () => {
    const transcript = [
      makeTurn('agent', '可以退款', 0),
      makeTurn('agent', '完成', 1),
    ];
    const r = evaluateMultiTurnTask(transcript, spec);
    expect(r.passed).toBe(false);
    expect(r.reasons.some((x) => /policy 违反/.test(x))).toBe(true);
  });

  it('轮数不足 → passed=false', () => {
    const transcript = [makeTurn('agent', '可以换货', 0)];
    const r = evaluateMultiTurnTask(transcript, spec);
    expect(r.passed).toBe(false);
    expect(r.reasons.some((x) => /轮数不足/.test(x))).toBe(true);
  });
});
