/**
 * src/engine/trace/traceEmitter.ts
 * 统一 trace 的内存发射器。
 *
 * 设计约束：
 * - 单例（module-level）内存存储，按 runId 组织 span；适配浏览器与 Node（vitest）两侧。
 * - 永不抛出：startSpan / endSpan 任意参数异常都静默兜底，不影响业务主流程。
 * - 提供 `startRun` / `getRun` / `listRuns` / `spansOf` / `aggregate` / `tree` / `reset`，
 *   供回放面板与成本归因直接消费。
 *
 * 主进程侧（electron/services/evaluation/a2a-trace.ts）通过桥接函数把既有
 * A2aTraceRecord 投影回本模型，使其与跨进程 trace 共用同一回放/归因口径。
 */
import {
  aggregateCost,
  buildSpanTree,
  newCorrelationId,
  newSpanId,
  spanLatencyMs,
  type CostAttribution,
  type SpanNode,
  type TraceRun,
  type TraceSpan,
  type TraceStatus,
} from './traceModel';

/** 开启一个 span 的入参（除自动派生的 id 外全部可选）。 */
export interface StartSpanInput {
  runId: string;
  kind: string;
  name: string;
  agentId?: string | null;
  correlationId?: string;
  parentSpanId?: string | null;
  traceId?: string;
  attributes?: Record<string, string | number | boolean | null>;
}

/** 结束一个 span 的补丁（status 默认 ok；可补 cost/tokens/latency）。 */
export interface EndSpanPatch {
  status?: TraceStatus;
  costUsd?: number | null;
  tokens?: number | null;
  latencyMs?: number | null;
  attributes?: Record<string, string | number | boolean | null>;
}

function nowIso(): string {
  return new Date().toISOString();
}

class TraceEmitter {
  private runs = new Map<string, TraceRun>();
  private spanIndex = new Map<string, TraceSpan>();

  /** 取或建一个 run（保证 span 落到一个存在的 run 下）。 */
  private ensureRun(runId: string, rootCorrelationId?: string): TraceRun {
    let run = this.runs.get(runId);
    if (!run) {
      run = {
        runId,
        rootCorrelationId: rootCorrelationId || newCorrelationId(),
        startedAt: nowIso(),
        endedAt: null,
        spans: [],
      };
      this.runs.set(runId, run);
    }
    return run;
  }

  /** 显式开启一个 run（可在首个 span 前建立，便于绑定 rootCorrelationId）。 */
  startRun(runId: string, rootCorrelationId?: string): TraceRun {
    return this.ensureRun(runId, rootCorrelationId);
  }

  /** 开启一个 span；返回 spanId。run 不存在会自动创建。 */
  startSpan(input: StartSpanInput): string {
    try {
      const spanId = newSpanId();
      const run = this.ensureRun(input.runId, input.correlationId);
      const span: TraceSpan = {
        spanId,
        parentSpanId: input.parentSpanId ?? null,
        correlationId: input.correlationId || run.rootCorrelationId,
        runId: input.runId,
        traceId: input.traceId,
        agentId: input.agentId ?? null,
        kind: input.kind,
        name: input.name,
        status: 'started',
        startedAt: nowIso(),
        endedAt: null,
        costUsd: null,
        tokens: null,
        latencyMs: null,
        attributes: input.attributes,
      };
      run.spans.push(span);
      this.spanIndex.set(spanId, span);
      return spanId;
    } catch {
      return '';
    }
  }

  /** 结束一个 span；补 status / cost / tokens / latency / attributes。 */
  endSpan(spanId: string, patch: EndSpanPatch = {}): void {
    try {
      const span = this.spanIndex.get(spanId);
      if (!span) return;
      span.status = patch.status ?? 'ok';
      span.endedAt = nowIso();
      if (patch.costUsd !== undefined) span.costUsd = patch.costUsd;
      if (patch.tokens !== undefined) span.tokens = patch.tokens;
      if (patch.latencyMs !== undefined) span.latencyMs = patch.latencyMs;
      if (patch.attributes) span.attributes = { ...span.attributes, ...patch.attributes };
    } catch {
      /* 静默兜底 */
    }
  }

  /** 取单个 run（含全部 span）。 */
  getRun(runId: string): TraceRun | undefined {
    return this.runs.get(runId);
  }

  /** 列出全部 run（按 startedAt 升序）。 */
  listRuns(): TraceRun[] {
    return [...this.runs.values()].sort(
      (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
    );
  }

  /** 取某 run 的 span 列表（按 startedAt 升序）。 */
  spansOf(runId: string): TraceSpan[] {
    const run = this.runs.get(runId);
    if (!run) return [];
    return [...run.spans].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }

  /** 成本归因（直接复用纯函数）。 */
  aggregate(runId: string): CostAttribution {
    return aggregateCost(this.spansOf(runId));
  }

  /** span 树（回放用，直接复用纯函数）。 */
  tree(runId: string): SpanNode[] {
    return buildSpanTree(this.spansOf(runId));
  }

  /** 计算单个 span 的时延（兜底用模型纯函数）。 */
  latencyOf(spanId: string): number | null {
    const span = this.spanIndex.get(spanId);
    return span ? spanLatencyMs(span) : null;
  }

  /** 清空内存（测试隔离用）。 */
  reset(): void {
    this.runs.clear();
    this.spanIndex.clear();
  }
}

/** 全局单例。 */
export const traceEmitter = new TraceEmitter();
