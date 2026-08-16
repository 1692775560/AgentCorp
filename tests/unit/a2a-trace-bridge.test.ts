/**
 * tests/unit/a2a-trace-bridge.test.ts
 * G10 桥接：统一 TraceSpan ↔ A2aTraceRecord 投影单测。
 *
 * 纯投影函数（toA2aTraceRecord / fromA2aTraceRecord），不触盘；
 * mock '@electron/utils/paths' 仅为防模块顶层 import 误触（与 a2a-trace.test 保持一致约定）。
 * 重点验证：G10 扩展字段（correlation_id / parent_span_id / agent_id / cost_usd / tokens / latency_ms）
 * 正确双向投影，以及旧 A2aTraceRecord（无 G10 字段）fromA2aTraceRecord 安全兜底不崩。
 *
 * 运行：pnpm test
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => '/tmp/agentcorp-bridge-test',
}));

import type { A2aTraceRecord } from '@/types/evaluation';
import type { TraceSpan } from '@/engine/trace/traceModel';
import { fromA2aTraceRecord, toA2aTraceRecord } from '@electron/services/evaluation/a2a-trace';

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

describe('a2a-trace bridge ', () => {
  it('toA2aTraceRecord 投影全部 G10 扩展字段', () => {
    const s = span({
      spanId: 'sp-1',
      runId: 'run-1',
      correlationId: 'cid-1',
      kind: 'judge',
      name: 'evaluate',
      parentSpanId: 'sp-root',
      agentId: 'agent-judge',
      endedAt: '2025-01-01T00:00:05.000Z',
      costUsd: 0.42,
      tokens: 2048,
      latencyMs: 1234,
    });
    const rec = toA2aTraceRecord(s, {
      delegator: 'agent:boss',
      delegatee: 'agent:judge',
      sessionKey: 'agent:judge:1',
      rootSessionId: 'sess-1',
    });
    // 既有 A2A 字段
    expect(rec.trace_id).toBe('sp-1');
    expect(rec.task_id).toBe('run-1');
    expect(rec.kind).toBe('status'); // 统一细分 kind 不入 A2A kind
    expect(rec.state).toBe('completed'); // status ok → completed
    expect(rec.summary).toBe('evaluate');
    expect(rec.delegator).toBe('agent:boss');
    expect(rec.delegatee).toBe('agent:judge');
    expect(rec.root_session_id).toBe('sess-1');
    // G10 扩展字段
    expect(rec.correlation_id).toBe('cid-1');
    expect(rec.parent_span_id).toBe('sp-root');
    expect(rec.agent_id).toBe('agent-judge');
    expect(rec.cost_usd).toBeCloseTo(0.42);
    expect(rec.tokens).toBe(2048);
    expect(rec.latency_ms).toBe(1234);
  });

  it('fromA2aTraceRecord 命中 G10 扩展字段并映射状态', () => {
    const rec: A2aTraceRecord = {
      trace_id: 'sp-2',
      task_id: 'run-2',
      parent_task_id: null,
      delegator: 'agent:boss',
      delegatee: 'agent:judge',
      round: 1,
      kind: 'status',
      state: 'failed',
      rework_of: null,
      channel: 'internal-rpc',
      sent_at: '2025-01-01T00:00:00.000Z',
      completed_at: '2025-01-01T00:00:03.000Z',
      summary: 'boom',
      session_key: 'agent:judge:2',
      root_session_id: 'sess-2',
      trigger: 'spawn',
      correlation_id: 'cid-2',
      parent_span_id: 'sp-parent',
      agent_id: 'agent-judge',
      cost_usd: 0.99,
      tokens: 512,
      latency_ms: 3000,
    };
    const s = fromA2aTraceRecord(rec);
    expect(s.spanId).toBe('sp-2');
    expect(s.correlationId).toBe('cid-2');
    expect(s.parentSpanId).toBe('sp-parent');
    expect(s.agentId).toBe('agent-judge');
    expect(s.status).toBe('error'); // failed → error
    expect(s.costUsd).toBeCloseTo(0.99);
    expect(s.tokens).toBe(512);
    expect(s.latencyMs).toBe(3000);
    expect(s.name).toBe('boom');
  });

  it('fromA2aTraceRecord 旧记录（无 G10 字段）安全兜底', () => {
    const rec: A2aTraceRecord = {
      trace_id: 'sp-legacy',
      task_id: 'run-legacy',
      parent_task_id: null,
      delegator: 'agent:boss',
      delegatee: 'agent:worker',
      round: 1,
      kind: 'status',
      state: 'completed',
      rework_of: null,
      channel: 'internal-rpc',
      sent_at: '2025-01-01T00:00:00.000Z',
      completed_at: null,
      summary: 'legacy',
      session_key: '',
      root_session_id: 'sess-legacy',
      trigger: 'spawn',
      // 无 G10 扩展字段
    };
    const s = fromA2aTraceRecord(rec);
    expect(s.correlationId).toBe('sess-legacy'); // 回退 root_session_id
    expect(s.parentSpanId).toBeNull(); // parent_task_id 为 null
    expect(s.agentId).toBeNull();
    expect(s.costUsd).toBeNull();
    expect(s.tokens).toBeNull();
    expect(s.latencyMs).toBeNull();
    expect(s.status).toBe('ok'); // completed → ok
    expect(s.attributes?.sessionKey).toBe('');
  });

  it('to → from 回合投影一致（correlation / cost / token / latency）', () => {
    const s = span({
      spanId: 'sp-rt',
      runId: 'run-rt',
      correlationId: 'cid-rt',
      kind: 'delegate',
      name: 'dispatch',
      agentId: 'agent-disp',
      costUsd: 0.1,
      tokens: 64,
      latencyMs: 12,
    });
    const rec = toA2aTraceRecord(s, { rootSessionId: 'sess-rt' });
    const back = fromA2aTraceRecord(rec);
    expect(back.spanId).toBe(s.spanId);
    expect(back.correlationId).toBe(s.correlationId);
    expect(back.runId).toBe(s.runId);
    expect(back.agentId).toBe(s.agentId);
    expect(back.costUsd).toBeCloseTo(s.costUsd!);
    expect(back.tokens).toBe(s.tokens);
    expect(back.latencyMs).toBe(s.latencyMs);
  });
});
