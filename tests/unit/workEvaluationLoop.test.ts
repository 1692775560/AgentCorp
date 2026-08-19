/**
 * tests/unit/workEvaluationLoop.test.ts
 *
 * 「用人 → 选人」回流的行为约束。
 *
 * 这条链路把 AgentCorp 从「面试评测台」变成「持续准入评审」：
 * 上岗后的真实交付会回流成新的评测证据，面试期承诺与上岗后表现因此可以对照。
 *
 * 两条不可退让的纪律：
 * 1. 产出太薄 / 缺 agent 身份 → 不评（宁可漏评，不可错评）。
 *    一条「收到」也能被裁判打出六个分，那种分进榜只会污染结论。
 * 2. 评测是观察者 → 它自己抛错时必须静默，绝不影响已经交付的工作。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const runEvaluation = vi.fn(async () => ({ agentId: 'a1' }));

vi.mock('@/stores/evaluation', () => ({
  useEvaluationStore: {
    getState: () => ({ runEvaluation }),
  },
}));

import {
  buildWorkTranscript,
  evaluateCompletedWork,
  shouldEvaluateWork,
  type CompletedWork,
} from '@/services/workEvaluationLoop';

const LONG_OUTPUT =
  '已完成订单合并脚本：读取两份 CSV、按 order_id 去重、金额字段归一为 float，并补了三个边界用例。';

function work(over: Partial<CompletedWork> = {}): CompletedWork {
  return {
    taskId: 'task-1',
    taskTitle: '合并订单表',
    taskDescription: '把两份 CSV 按 order_id 合并',
    agentId: 'agent-1',
    agentName: '数据工程师',
    output: LONG_OUTPUT,
    ...over,
  };
}

beforeEach(() => {
  runEvaluation.mockClear();
});

describe('shouldEvaluateWork · 宁可漏评不可错评', () => {
  it('正常交付值得回流', () => {
    expect(shouldEvaluateWork(work())).toBe(true);
  });

  it('产出过短不评（「收到」不是可评的证据）', () => {
    expect(shouldEvaluateWork(work({ output: '收到' }))).toBe(false);
    expect(shouldEvaluateWork(work({ output: '   ' }))).toBe(false);
  });

  it('缺 agent 身份不评（分数必须落到具体的人头上）', () => {
    expect(shouldEvaluateWork(work({ agentId: '' }))).toBe(false);
    expect(shouldEvaluateWork(work({ agentName: '' }))).toBe(false);
  });

  it('空入参不炸', () => {
    expect(shouldEvaluateWork(null)).toBe(false);
    expect(shouldEvaluateWork(undefined)).toBe(false);
  });
});

describe('buildWorkTranscript · 过程事实如实记录', () => {
  it('包含任务、需求与交付物', () => {
    const t = buildWorkTranscript(work());
    expect(t).toContain('合并订单表');
    expect(t).toContain('把两份 CSV 按 order_id 合并');
    expect(t).toContain(LONG_OUTPUT);
    expect(t).toContain('上岗期真实任务');
  });

  it('返工轮数作为客观事实写入，不预先扣分', () => {
    const t = buildWorkTranscript(work({ reworkRounds: 2 }));
    expect(t).toContain('经过 2 轮返工后交付');
    // 只陈述事实，不出现任何预判性的评价词
    expect(t).not.toContain('质量差');
    expect(t).not.toContain('扣分');
  });

  it('零返工时不写过程记录（没发生的事不记）', () => {
    expect(buildWorkTranscript(work({ reworkRounds: 0 }))).not.toContain('返工');
  });

  it('未通过验收如实记录', () => {
    expect(buildWorkTranscript(work({ approved: false }))).toContain('未通过 leader 验收');
  });
});

describe('evaluateCompletedWork · 观察者不得成为故障点', () => {
  it('满足条件时触发评测，并带上交付物作为转录兜底', async () => {
    await evaluateCompletedWork(work({ runId: 'run-9', sessionId: 's1', sessionKey: 'k1' }));
    expect(runEvaluation).toHaveBeenCalledTimes(1);
    const arg = runEvaluation.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(arg.agentId).toBe('agent-1');
    expect(arg.runId).toBe('run-9');
    expect(String(arg.transcriptFallback)).toContain(LONG_OUTPUT);
  });

  it('不满足条件时根本不调用评测', async () => {
    const result = await evaluateCompletedWork(work({ output: 'ok' }));
    expect(result).toBeNull();
    expect(runEvaluation).not.toHaveBeenCalled();
  });

  it('评测抛错时静默返回 null（交付不受影响）', async () => {
    runEvaluation.mockRejectedValueOnce(new Error('judge 挂了'));
    await expect(evaluateCompletedWork(work())).resolves.toBeNull();
  });
});
