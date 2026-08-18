/**
 * tests/unit/traceModel.test.ts
 * 统一 trace 模型纯函数单测（可回放 / 成本归因）。
 * 运行：pnpm test
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateCost,
  buildSpanTree,
  newCorrelationId,
  newSpanId,
  spanLatencyMs,
  type TraceSpan,
} from '@/engine/trace/traceModel';

function span(
  p: Partial<TraceSpan> &
    Pick<TraceSpan, 'spanId' | 'runId' | 'correlationId' | 'kind' | 'name' | 'startedAt'>,
): TraceSpan {
  return {
    status: 'ok',
    endedAt: null,
    agentId: null,
    costUsd: null,
    tokens: null,
    latencyMs: null,
    attributes: undefined,
    ...p,
  };
}

describe('traceModel', () => {
  it('newCorrelationId / newSpanId 生成非空唯一字符串', () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
    expect(newSpanId()).not.toBe(newSpanId());
  });

  it('buildSpanTree 还原层级；多 root 包一层虚拟 __root__', () => {
    const spans: TraceSpan[] = [
      span({ spanId: 'root', parentSpanId: null, startedAt: '2025-01-01T00:00:00.000Z' }),
      span({ spanId: 'child', parentSpanId: 'root', startedAt: '2025-01-01T00:00:01.000Z' }),
      span({ spanId: 'orphan', parentSpanId: null, startedAt: '2025-01-01T00:00:02.000Z' }),
    ];
    const tree = buildSpanTree(spans);
    expect(tree).toHaveLength(1);
    expect(tree[0].spanId).toBe('__root__');
    expect(tree[0].children.map((c) => c.spanId).sort()).toEqual(['orphan', 'root']);
    const root = tree[0].children.find((c) => c.spanId === 'root')!;
    expect(root.children.map((c) => c.spanId)).toEqual(['child']);
  });

  it('buildSpanTree 单 root 直接返回（无虚拟 root）', () => {
    const spans = [span({ spanId: 'a', parentSpanId: null, startedAt: '2025-01-01T00:00:00.000Z' })];
    const tree = buildSpanTree(spans);
    expect(tree).toHaveLength(1);
    expect(tree[0].spanId).toBe('a');
  });

  it('aggregateCost 按 agent 聚合 cost/tokens/latency，未知 agent 归 __unknown__', () => {
    const spans: TraceSpan[] = [
      span({
        spanId: 's1',
        agentId: 'agent-1',
        costUsd: 0.2,
        tokens: 1500,
        latencyMs: 100,
        startedAt: '2025-01-01T00:00:00.000Z',
      }),
      span({
        spanId: 's2',
        agentId: 'agent-1',
        costUsd: 0.3,
        tokens: 2500,
        latencyMs: 200,
        startedAt: '2025-01-01T00:00:01.000Z',
      }),
      span({
        spanId: 's3',
        agentId: null,
        costUsd: 0.5,
        tokens: 100,
        latencyMs: 50,
        startedAt: '2025-01-01T00:00:02.000Z',
      }),
    ];
    const agg = aggregateCost(spans);
    expect(agg.totalCostUsd).toBeCloseTo(1.0);
    expect(agg.totalTokens).toBe(4100);
    expect(agg.totalLatencyMs).toBe(350);
    expect(agg.spanCount).toBe(3);
    expect(agg.byAgent['agent-1'].costUsd).toBeCloseTo(0.5);
    expect(agg.byAgent['agent-1'].spanCount).toBe(2);
    expect(agg.byAgent['__unknown__'].costUsd).toBeCloseTo(0.5);
    expect(agg.byAgent['__unknown__'].tokens).toBe(100);
  });

  it('spanLatencyMs 优先显式值，否则由 startedAt/endedAt 推算', () => {
    expect(spanLatencyMs(span({ spanId: 'x', startedAt: '2025-01-01T00:00:00.000Z', latencyMs: 42 }))).toBe(42);
    expect(
      spanLatencyMs(span({ spanId: 'x', startedAt: '2025-01-01T00:00:00.000Z', endedAt: '2025-01-01T00:00:05.000Z' })),
    ).toBe(5000);
    expect(spanLatencyMs(span({ spanId: 'x', startedAt: '2025-01-01T00:00:00.000Z' }))).toBeNull();
  });
});
