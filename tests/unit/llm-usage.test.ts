/**
 * tests/unit/llm-usage.test.ts
 *
 * 成本看板纯函数验证（src/services/llmUsage.ts）：
 * - parseChatUsage：有/无 usage 字段、snake_case/camelCase、total 兜底；
 * - estimateCostCny：DeepSeek 刊例计算、未知模型兜底价；
 * - aggregateUsage：按 agent/team/task groupBy、无归属归「未归属」、降序；
 * - filterUsageByRange：今天 / 近7天 / 全部。
 */
import { describe, expect, it } from 'vitest';

import {
  aggregateUsage,
  estimateCostCny,
  estimateRecordCostCny,
  filterUsageByRange,
  parseChatUsage,
  type LlmUsageRecord,
} from '@/services/llmUsage';

describe('parseChatUsage', () => {
  it('解析 OpenAI 兼容的 snake_case usage 字段', () => {
    expect(
      parseChatUsage({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }),
    ).toEqual({ promptTokens: 120, completionTokens: 30, totalTokens: 150 });
  });

  it('兼容 camelCase 字段', () => {
    expect(
      parseChatUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
    ).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('total 缺失时由 prompt+completion 兜底', () => {
    expect(parseChatUsage({ prompt_tokens: 7, completion_tokens: 3 })).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    });
  });

  it('无 usage / 非对象 / 全零时返回 null（不计入）', () => {
    expect(parseChatUsage(undefined)).toBeNull();
    expect(parseChatUsage(null)).toBeNull();
    expect(parseChatUsage('usage')).toBeNull();
    expect(parseChatUsage({})).toBeNull();
    expect(parseChatUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toBeNull();
  });
});

describe('estimateCostCny', () => {
  it('deepseek-chat 按 ¥2/百万输入 + ¥8/百万输出计价', () => {
    // 1_000_000 输入 + 1_000_000 输出 = ¥2 + ¥8 = ¥10
    expect(estimateCostCny({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, 'deepseek-chat')).toBeCloseTo(10);
  });

  it('deepseek-reasoner 按 ¥4/百万输入 + ¥16/百万输出计价', () => {
    expect(estimateCostCny({ promptTokens: 500_000, completionTokens: 100_000 }, 'deepseek-reasoner')).toBeCloseTo(2 + 1.6);
  });

  it('未知模型 / 空模型按 deepseek-chat 兜底估价', () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 0 };
    expect(estimateCostCny(usage, 'some-other-model')).toBeCloseTo(estimateCostCny(usage, 'deepseek-chat'));
    expect(estimateCostCny(usage, null)).toBeCloseTo(2);
  });

  it('estimateRecordCostCny 使用记录自带的 model', () => {
    const record: LlmUsageRecord = {
      ts: '2026-08-18T00:00:00.000Z',
      model: 'deepseek-chat',
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
    };
    expect(estimateRecordCostCny(record)).toBeCloseTo(2);
  });
});

function rec(partial: Partial<LlmUsageRecord>): LlmUsageRecord {
  return {
    ts: '2026-08-18T00:00:00.000Z',
    model: 'deepseek-chat',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    ...partial,
  };
}

describe('aggregateUsage', () => {
  const records = [
    rec({ agentId: 'a1', teamId: 't1', taskId: 'task-1', promptTokens: 100, completionTokens: 50, totalTokens: 150 }),
    rec({ agentId: 'a1', teamId: 't1', taskId: 'task-2', promptTokens: 200, completionTokens: 50, totalTokens: 250 }),
    rec({ agentId: 'a2', teamId: 't2', taskId: 'task-1', promptTokens: 50, completionTokens: 50, totalTokens: 100 }),
    rec({ promptTokens: 10, completionTokens: 0, totalTokens: 10 }), // 无归属
  ];

  it('按 agent 归集：合并同 agent、降序、累计成本', () => {
    const rows = aggregateUsage(records, 'agent');
    expect(rows.map((r) => r.key)).toEqual(['a1', 'a2', '未归属']);
    expect(rows[0]).toMatchObject({ calls: 2, promptTokens: 300, completionTokens: 100, totalTokens: 400 });
    // a1 成本：(300/1e6)*2 + (100/1e6)*8 = 0.0014
    expect(rows[0].costCny).toBeCloseTo(0.0014);
  });

  it('按 team 归集', () => {
    const rows = aggregateUsage(records, 'team');
    expect(rows.map((r) => r.key)).toEqual(['t1', 't2', '未归属']);
    expect(rows[0]).toMatchObject({ calls: 2, totalTokens: 400 });
  });

  it('按 task 归集', () => {
    const rows = aggregateUsage(records, 'task');
    expect(rows.map((r) => r.key)).toEqual(['task-1', 'task-2', '未归属']);
    expect(rows[0]).toMatchObject({ calls: 2, totalTokens: 250 });
  });

  it('空输入返回空数组', () => {
    expect(aggregateUsage([], 'agent')).toEqual([]);
  });
});

describe('filterUsageByRange', () => {
  // 固定「现在」为 2026-08-18 12:00 本地时间
  const now = new Date(2026, 7, 18, 12, 0, 0).getTime();
  const at = (y: number, m: number, d: number, h = 0) =>
    rec({ ts: new Date(y, m, d, h).toISOString() });

  const records = [
    at(2026, 7, 18, 1),   // 今天凌晨
    at(2026, 7, 17, 23),  // 昨天
    at(2026, 7, 12, 12),  // 6 天前（7d 边界内）
    at(2026, 7, 11, 12),  // 7 天前（7d 边界外）
    at(2026, 6, 1, 12),   // 7 月
  ];

  it('today：只保留今天（本地 0 点起）', () => {
    const rows = filterUsageByRange(records, 'today', now);
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe(records[0].ts);
  });

  it('7d：含今天在内最近 7 个自然日', () => {
    const rows = filterUsageByRange(records, '7d', now);
    expect(rows).toHaveLength(3);
  });

  it('all：原样返回', () => {
    expect(filterUsageByRange(records, 'all', now)).toHaveLength(5);
  });

  it('非法时间戳的记录在时间过滤时被丢弃', () => {
    const bad = rec({ ts: 'not-a-date' });
    expect(filterUsageByRange([bad], 'today', now)).toHaveLength(0);
    expect(filterUsageByRange([bad], 'all', now)).toHaveLength(1);
  });
});
