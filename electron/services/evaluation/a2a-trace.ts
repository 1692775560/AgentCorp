/**
 * electron/services/evaluation/a2a-trace.ts
 * A2A 委派 trace 记录与读写（主进程，a2a-integration.md §3.4 / P1）。
 *
 * 无论走私有 chat.send（内部委派）还是未来的 A2A message/send（外部委派），
 * 委派事件都按统一 schema 追加落盘为 JSONL：
 *   ~/.openclaw/a2a-traces/<rootSessionId>.jsonl（每行一条 A2aTraceRecord）
 * 让评估层从「读聊天记录猜协作」升级为「读协作日志算指标」。
 *
 * 容错原则：trace 是评估证据的旁路采集，读写任一步失败都绝不抛出、
 * 绝不影响委派主流程（spawn/steer/kill）与评估采集（collectRunData）。
 *
 * 两路 Trace 对齐：本文件（Electron 委派链路）与 web demo 闭环的
 * `src/demo/observability/traceSink.ts`（run-<id>.jsonl）是同级 Trace 证据，
 * 字段映射——
 *   trace_id ↔ runId（根关联）      delegator/delegatee ↔ agent
 *   state ↔ status                  summary ↔ steps[].summary
 * 统一迁移路径：两者均可经 `src/demo/observability/otelGenai.ts` 投影为
 * OTel GenAI span（gen_ai.agent.name / gen_ai.conversation.id / gen_ai.skill.id）。
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getOpenClawConfigDir } from '../../utils/paths';
import type { A2aTraceRecord } from '../../../src/types/evaluation';
import type { TraceSpan, TraceStatus } from '../../../src/engine/trace/traceModel';

/** trace 落盘目录（~/.openclaw/a2a-traces） */
export function getA2aTracesDir(): string {
  return join(getOpenClawConfigDir(), 'a2a-traces');
}

/** 文件名安全化：rootSessionId 理论上是 UUID，仍兜底剥掉路径分隔等特殊字符 */
function sanitizeTraceFileName(rootSessionId: string): string {
  return rootSessionId.replace(/[^A-Za-z0-9._-]/g, '_');
}

function traceFilePath(rootSessionId: string, dirOverride?: string): string {
  return join(dirOverride ?? getA2aTracesDir(), `${sanitizeTraceFileName(rootSessionId)}.jsonl`);
}

/**
 * 从 sessionKey 派生根会话 ID（trace 文件名 / collectRunData 关联键）。
 * sessionKey 形如 `agent:<agentId>:<sessionId>`，子代理再叠 `:subagent:<runtimeId>`；
 * 根会话 ID 即首个 `:subagent:` 之前、`agent:<agentId>:` 之后的部分。
 * 无法解析时回退整串；空串返回 ''（调用方应跳过写 trace）。
 */
export function deriveRootSessionId(sessionKey: string): string {
  const head = sessionKey.split(':subagent:')[0]?.trim() ?? '';
  if (!head) return '';
  const parts = head.split(':');
  if (parts[0] === 'agent' && parts.length >= 3) {
    return parts.slice(2).join(':');
  }
  return head;
}

/** 从 parentSessionKey 派生 delegator 引用（`agent:<leaderId>`，无法解析时 'unknown'） */
export function delegatorFromSessionKey(parentSessionKey: string): string {
  const parts = parentSessionKey.split(':');
  if (parts[0] === 'agent' && parts[1]) {
    return `agent:${parts[1]}`;
  }
  return 'unknown';
}

/** 追加一条 trace（目录自动创建）。永不抛出；成功返回 true，失败返回 false。 */
export async function appendA2aTrace(
  record: A2aTraceRecord,
  dirOverride?: string,
): Promise<boolean> {
  try {
    const dir = dirOverride ?? getA2aTracesDir();
    await mkdir(dir, { recursive: true });
    await appendFile(traceFilePath(record.root_session_id, dir), `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 宽容解析单行 JSON，坏行跳过（返回 null） */
function parseTraceLine(line: string): A2aTraceRecord | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value !== 'object' || value == null) return null;
    if (typeof value.trace_id !== 'string' || typeof value.task_id !== 'string') return null;
    return value as unknown as A2aTraceRecord;
  } catch {
    return null;
  }
}

/** 读取某根会话的全部 trace（按 sent_at 升序）。文件缺失/损坏时返回 []，永不抛出。 */
export async function readA2aTraces(
  rootSessionId: string,
  dirOverride?: string,
): Promise<A2aTraceRecord[]> {
  if (!rootSessionId) return [];
  try {
    const raw = await readFile(traceFilePath(rootSessionId, dirOverride), 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(parseTraceLine)
      .filter((record): record is A2aTraceRecord => record != null)
      .sort((a, b) => a.sent_at.localeCompare(b.sent_at));
  } catch {
    return [];
  }
}

/**
 * 按 sessionId / agentId 关联 trace 记录（collectRunData 的第三数据源）。
 * 优先读 `<sessionId>.jsonl`（评估 leader 会话的常见路径）；读不到时全目录扫描，
 * 匹配 root_session_id / task_id / session_key 命中 sessionId，
 * 或 delegator / delegatee 命中 `agent:<agentId>` 的记录（评估 worker 会话的路径）。
 * 永不抛出；无关联记录返回 []（调用方保持既有兜底行为）。
 */
export async function loadA2aTracesForRun(
  agentId: string,
  sessionId: string,
  dirOverride?: string,
): Promise<A2aTraceRecord[]> {
  try {
    const direct = await readA2aTraces(sessionId, dirOverride);
    if (direct.length > 0) return direct;

    const dir = dirOverride ?? getA2aTracesDir();
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const agentRef = agentId ? `agent:${agentId}` : '';
    const matched: A2aTraceRecord[] = [];
    for (const fileName of files) {
      if (!fileName.endsWith('.jsonl')) continue;
      const rootSessionId = fileName.slice(0, -'.jsonl'.length);
      for (const record of await readA2aTraces(rootSessionId, dirOverride)) {
        if (
          record.root_session_id === sessionId
          || record.task_id === sessionId
          || record.session_key === sessionId
          || (agentRef !== '' && (record.delegator === agentRef || record.delegatee === agentRef))
        ) {
          matched.push(record);
        }
      }
    }
    return matched.sort((a, b) => a.sent_at.localeCompare(b.sent_at));
  } catch {
    return [];
  }
}

/* ===================== 桥接：统一 trace 模型 ↔ A2aTraceRecord =====================
 * 复用既有 A2A trace 落盘（appendA2aTrace / readA2aTraces），不 fork 一套新落盘。
 * 通过投影把统一 TraceSpan（含 correlation_id / agent_id / cost_usd / tokens / latency_ms）
 * 写入 A2aTraceRecord 的扩展字段，使跨进程 trace 与主进程 trace 共用同一回放与归因口径。 */

/** A2A 侧状态 → 统一 trace 状态。 */
function a2aStateToTraceStatus(state: A2aTraceRecord['state']): TraceStatus {
  switch (state) {
    case 'completed':
      return 'ok';
    case 'failed':
      return 'error';
    case 'canceled':
      return 'canceled';
    case 'working':
    case 'input-required':
    case 'submitted':
    default:
      return 'started';
  }
}

/** 统一 trace 状态 → A2A 侧状态。 */
function traceStatusToA2aState(status: TraceStatus): A2aTraceRecord['state'] {
  switch (status) {
    case 'ok':
      return 'completed';
    case 'error':
      return 'failed';
    case 'canceled':
      return 'canceled';
    case 'started':
    default:
      return 'working';
  }
}

/** 把统一 TraceSpan 投影为落盘用 A2aTraceRecord（补全 A2A 既有字段的默认值）。 */
export function toA2aTraceRecord(
  span: TraceSpan,
  opts: {
    delegator?: string;
    delegatee?: string;
    sessionKey?: string;
    rootSessionId?: string;
    trigger?: A2aTraceRecord['trigger'];
  } = {},
): A2aTraceRecord {
  return {
    trace_id: span.spanId,
    task_id: span.runId,
    parent_task_id: span.parentSpanId ?? null,
    delegator: opts.delegator ?? 'unknown',
    delegatee: opts.delegatee ?? `agent:${span.agentId ?? 'unknown'}`,
    round: 1,
    // A2A kind 仅 message/status/artifact；统一 trace 的细分 kind 保留在 attributes
    kind: 'status',
    state: traceStatusToA2aState(span.status),
    rework_of: null,
    channel: 'internal-rpc',
    sent_at: span.startedAt,
    completed_at: span.endedAt ?? null,
    summary: span.name,
    session_key: opts.sessionKey ?? '',
    root_session_id: opts.rootSessionId ?? span.runId,
    trigger: opts.trigger ?? 'spawn',
    // 扩展字段
    correlation_id: span.correlationId,
    parent_span_id: span.parentSpanId ?? null,
    agent_id: span.agentId ?? null,
    cost_usd: span.costUsd ?? null,
    tokens: span.tokens ?? null,
    latency_ms: span.latencyMs ?? null,
  };
}

/** 把落盘 A2aTraceRecord 反向投影为统一 TraceSpan（扩展字段缺失时安全兜底）。 */
export function fromA2aTraceRecord(record: A2aTraceRecord): TraceSpan {
  return {
    spanId: record.trace_id,
    parentSpanId: record.parent_span_id ?? record.parent_task_id ?? null,
    correlationId: record.correlation_id ?? record.root_session_id,
    runId: record.task_id || record.root_session_id,
    traceId: record.trace_id,
    agentId: record.agent_id ?? null,
    kind: record.kind,
    name: record.summary,
    status: a2aStateToTraceStatus(record.state),
    startedAt: record.sent_at,
    endedAt: record.completed_at ?? null,
    costUsd: record.cost_usd ?? null,
    tokens: record.tokens ?? null,
    latencyMs: record.latency_ms ?? null,
    attributes: {
      sessionKey: record.session_key,
      rootSessionId: record.root_session_id,
      channel: record.channel,
    },
  };
}
