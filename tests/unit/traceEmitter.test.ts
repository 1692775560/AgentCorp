/**
 * tests/unit/traceEmitter.test.ts
 * G10 统一 trace 发射器单测（内存采集 / 回放 / 成本归因）。
 * 验证单例 traceEmitter 的 startSpan / endSpan / aggregate / tree / reset / latencyOf。
 * 运行：pnpm test
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { traceEmitter } from '@/engine/trace/traceEmitter';

describe('traceEmitter ', () => {
  beforeEach(() => {
    traceEmitter.reset();
  });

  it('startSpan 返回非空 spanId 且自动建 run', () => {
    const runId = 'run-1';
    const spanId = traceEmitter.startSpan({ runId, kind: 'judge', name: 'eval' });
    expect(typeof spanId).toBe('string');
    expect(spanId.length).toBeGreaterThan(0);
    const run = traceEmitter.getRun(runId);
    expect(run).toBeDefined();
    expect(run!.spans).toHaveLength(1);
    expect(run!.rootCorrelationId).toBeTruthy();
    expect(run!.spans[0].spanId).toBe(spanId);
    expect(run!.spans[0].status).toBe('started');
  });

  it('startSpan 用 correlationId 绑定 run 的 rootCorrelationId 与 span', () => {
    const runId = 'run-2';
    const cid = 'cid-xyz';
    const spanId = traceEmitter.startSpan({
      runId,
      kind: 'interview',
      name: 'iv',
      correlationId: cid,
    });
    const run = traceEmitter.getRun(runId)!;
    expect(run.rootCorrelationId).toBe(cid);
    expect(run.spans[0].spanId).toBe(spanId);
    expect(run.spans[0].correlationId).toBe(cid);
  });

  it('endSpan 关闭 span 并补 status / cost / tokens / latency', () => {
    const spanId = traceEmitter.startSpan({ runId: 'run-3', kind: 'judge', name: 'eval' });
    traceEmitter.endSpan(spanId, { status: 'ok', costUsd: 0.3, tokens: 1200, latencyMs: 800 });
    const span = traceEmitter.spansOf('run-3')[0];
    expect(span.status).toBe('ok');
    expect(span.endedAt).not.toBeNull();
    expect(span.costUsd).toBeCloseTo(0.3);
    expect(span.tokens).toBe(1200);
    expect(span.latencyMs).toBe(800);
  });

  it('endSpan 对未知 spanId 静默无副作用（永不抛出）', () => {
    expect(() => traceEmitter.endSpan('nope', { status: 'ok' })).not.toThrow();
  });

  it('startRun 显式建 run 并可绑定 rootCorrelationId', () => {
    const run = traceEmitter.startRun('run-4', 'cid-explicit');
    expect(run.rootCorrelationId).toBe('cid-explicit');
    expect(traceEmitter.listRuns().some((r) => r.runId === 'run-4')).toBe(true);
  });

  it('aggregate 按 agent 聚合成本 / token / 时延；未知 agent 归 __unknown__', () => {
    const s1 = traceEmitter.startSpan({ runId: 'run-5', kind: 'judge', name: 'j1', agentId: 'a1' });
    const s2 = traceEmitter.startSpan({ runId: 'run-5', kind: 'judge', name: 'j2', agentId: 'a1' });
    const s3 = traceEmitter.startSpan({ runId: 'run-5', kind: 'judge', name: 'j3', agentId: null });
    traceEmitter.endSpan(s1, { costUsd: 0.2, tokens: 1500, latencyMs: 100 });
    traceEmitter.endSpan(s2, { costUsd: 0.3, tokens: 2500, latencyMs: 200 });
    traceEmitter.endSpan(s3, { costUsd: 0.5, tokens: 100, latencyMs: 50 });
    const agg = traceEmitter.aggregate('run-5');
    expect(agg.totalCostUsd).toBeCloseTo(1.0);
    expect(agg.totalTokens).toBe(4100);
    expect(agg.totalLatencyMs).toBe(350);
    expect(agg.spanCount).toBe(3);
    expect(agg.byAgent['a1'].spanCount).toBe(2);
    expect(agg.byAgent['a1'].costUsd).toBeCloseTo(0.5);
    expect(agg.byAgent['__unknown__'].costUsd).toBeCloseTo(0.5);
    expect(agg.byAgent['__unknown__'].tokens).toBe(100);
  });

  it('tree 还原父子层级（单 root）', () => {
    const root = traceEmitter.startSpan({
      runId: 'run-6',
      kind: 'delegate',
      name: 'root',
      parentSpanId: null,
    });
    traceEmitter.startSpan({ runId: 'run-6', kind: 'tool', name: 'child', parentSpanId: root });
    const tree = traceEmitter.tree('run-6');
    expect(tree).toHaveLength(1);
    expect(tree[0].spanId).toBe(root);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].name).toBe('child');
  });

  it('tree 对未知 run 返回 []', () => {
    expect(traceEmitter.tree('nope')).toEqual([]);
  });

  it('latencyOf 返回 span 时延，未知 span 返回 null', () => {
    const s = traceEmitter.startSpan({ runId: 'run-7', kind: 'judge', name: 'j' });
    traceEmitter.endSpan(s, { latencyMs: 777 });
    expect(traceEmitter.latencyOf(s)).toBe(777);
    expect(traceEmitter.latencyOf('nope')).toBeNull();
  });

  it('listRuns 按 startedAt 升序', async () => {
    traceEmitter.startRun('a', 'cid-a');
    await new Promise((r) => setTimeout(r, 5)); // 确保 a 的 startedAt 严格早于 b
    traceEmitter.startRun('b', 'cid-b');
    expect(traceEmitter.listRuns().map((r) => r.runId)).toEqual(['a', 'b']);
  });

  it('reset 清空内存', () => {
    traceEmitter.startSpan({ runId: 'run-8', kind: 'judge', name: 'j' });
    expect(traceEmitter.listRuns()).toHaveLength(1);
    traceEmitter.reset();
    expect(traceEmitter.listRuns()).toEqual([]);
  });
});
