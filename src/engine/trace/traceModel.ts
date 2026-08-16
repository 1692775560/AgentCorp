/**
 * src/engine/trace/traceModel.ts
 * 统一 trace 模型。
 *
 * 设计目标：让每一次「面试 / 评估 / 委派」都可追溯、可回放、可归因成本。
 * - 跨进程关联：用 `correlationId` 把分散在渲染层 / 主进程 / 网关侧的事件串成一条链；
 * - 回放：用 `buildSpanTree` 把扁平 span 列表还原成层级调用树；
 * - 成本归因：用 `aggregateCost` 按 agent 聚合 cost / token / latency。
 *
 * 本文件为纯函数 + 纯类型，**不 import 任何外部模块**，可在渲染层与主进程两侧
 * 直接用 type-only import，也可被 a2a-trace 桥接层投影到既有 A2aTraceRecord。
 */

/** 一次 span 的生命周期状态。 */
export type TraceStatus = 'started' | 'ok' | 'error' | 'canceled';

/** 单个 trace span（最小可归因单元）。 */
export interface TraceSpan {
  /** span 唯一 id（≈ OpenTelemetry span id） */
  spanId: string;
  /** 父 span id；root span 为 null/undefined */
  parentSpanId?: string | null;
  /** 跨进程 / 跨调用关联键（把分散事件串成链） */
  correlationId: string;
  /** 一次端到端运行（面试 / 评估 / 委派）的 id */
  runId: string;
  /** 兼容 A2A trace_id（可选） */
  traceId?: string;
  /** 执行主体（agentId）；未知时为 null */
  agentId?: string | null;
  /** span 类别：interview | judge | delegate | tool | ... */
  kind: string;
  /** 人类可读名称 */
  name: string;
  status: TraceStatus;
  /** ISO8601 开始时间 */
  startedAt: string;
  /** ISO8601 结束时间；未结束为 null */
  endedAt?: string | null;
  /** 端到端时延（ms），由 endedAt - startedAt 推算或显式给定 */
  latencyMs?: number | null;
  /** 该 span 产生的成本（美元） */
  costUsd?: number | null;
  /** 该 span 消耗的 token 数 */
  tokens?: number | null;
  /** 自由属性（sessionKey / taskId / channel 等上下文） */
  attributes?: Record<string, string | number | boolean | null>;
}

/** 一次完整运行（含其全部 span）。 */
export interface TraceRun {
  runId: string;
  rootCorrelationId: string;
  startedAt: string;
  endedAt?: string | null;
  spans: TraceSpan[];
}

/** 带子节点的 span 树节点（buildSpanTree 产物）。 */
export interface SpanNode extends TraceSpan {
  children: SpanNode[];
}

/** 按 agent 维度的成本归因聚合。 */
export interface AgentCostSlice {
  costUsd: number;
  tokens: number;
  latencyMs: number;
  spanCount: number;
}

export interface CostAttribution {
  totalCostUsd: number;
  totalTokens: number;
  totalLatencyMs: number;
  spanCount: number;
  byAgent: Record<string, AgentCostSlice>;
}

/** 生成关联 id（优先用 Web Crypto，退化到时间戳+随机）。 */
export function newCorrelationId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 生成 span id（优先用 Web Crypto，退化到时间戳+随机）。 */
export function newSpanId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 由 startedAt/endedAt 计算时延（ms），缺失时回退显式 latencyMs 或 null。 */
export function spanLatencyMs(span: TraceSpan): number | null {
  if (typeof span.latencyMs === 'number') return span.latencyMs;
  if (span.endedAt) {
    const start = Date.parse(span.startedAt);
    const end = Date.parse(span.endedAt);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
      return end - start;
    }
  }
  return null;
}

/**
 * 把扁平 span 列表还原成层级树。
 * - root = parentSpanId 为空或在列表中找不到对应 span 的节点；
 * - 若多个 root，额外包一个虚拟 root（spanId='__root__'）作为统一入口；
 * - 子节点按 startedAt 升序。
 */
export function buildSpanTree(spans: TraceSpan[]): SpanNode[] {
  const byId = new Map<string, SpanNode>();
  for (const span of spans) {
    byId.set(span.spanId, { ...span, children: [] });
  }

  const roots: SpanNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.parentSpanId ?? null;
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortRec = (nodes: SpanNode[]): void => {
    nodes.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);

  if (roots.length <= 1) return roots;

  // 多 root：包一层虚拟 root，便于单一入口回放
  return [
    {
      spanId: '__root__',
      correlationId: spans[0]?.correlationId ?? '',
      runId: spans[0]?.runId ?? '',
      kind: 'virtual',
      name: 'run-root',
      status: 'ok',
      startedAt: roots.map((r) => r.startedAt).sort()[0] ?? new Date(0).toISOString(),
      endedAt: null,
      children: roots,
    },
  ];
}

/**
 * 按 agent 聚合成本 / token / 时延。未知 agent 归入 '__unknown__'。
 * 纯函数，不修改入参。
 */
export function aggregateCost(spans: TraceSpan[]): CostAttribution {
  const byAgent: Record<string, AgentCostSlice> = {};
  let totalCostUsd = 0;
  let totalTokens = 0;
  let totalLatencyMs = 0;
  let spanCount = 0;

  const ensure = (key: string): AgentCostSlice => {
    if (!byAgent[key]) byAgent[key] = { costUsd: 0, tokens: 0, latencyMs: 0, spanCount: 0 };
    return byAgent[key];
  };

  for (const span of spans) {
    const key = span.agentId && span.agentId.trim() ? span.agentId : '__unknown__';
    const slice = ensure(key);
    slice.costUsd += typeof span.costUsd === 'number' ? span.costUsd : 0;
    slice.tokens += typeof span.tokens === 'number' ? span.tokens : 0;
    const lat = spanLatencyMs(span);
    slice.latencyMs += lat ?? 0;
    slice.spanCount += 1;

    totalCostUsd += typeof span.costUsd === 'number' ? span.costUsd : 0;
    totalTokens += typeof span.tokens === 'number' ? span.tokens : 0;
    totalLatencyMs += lat ?? 0;
    spanCount += 1;
  }

  return { totalCostUsd, totalTokens, totalLatencyMs, spanCount, byAgent };
}
