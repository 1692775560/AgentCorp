/**
 * OpenTelemetry GenAI 语义映射（GOAI 要求 4 可观测 · SP-09）
 * --------------------------------------------------------------------------
 * 把自研的 `LoopStep`（闭环轨迹）与 token 用量记录映射到 OTel GenAI
 * 语义约定（opentelemetry semantic-conventions gen-ai 1.x）的字段命名，
 * 使 AgentCorp 的 Trace/Metrics 能被任何 OTel 兼容后端（Langfuse / Phoenix /
 * Jaeger）直接消费，评审可按规范字段核对。
 *
 * 映射对照：
 *   LoopStep.agentName  → gen_ai.agent.name
 *   LoopStep.agentRole  → gen_ai.agent.role（扩展属性，规范未定义 agent.role 时保留）
 *   runId/sessionId     → gen_ai.conversation.id
 *   LoopStep.skill      → gen_ai.operation.name（invoke_skill）/ agentcorp.skill.id
 *   token usage         → gen_ai.usage.input_tokens / output_tokens / cost（扩展）
 *
 * 本模块纯函数、零依赖，web demo 与 vitest 均可直接运行。
 */
import type { LoopStep } from '../closedLoop';

/** OTel GenAI span 属性集（扁平 key-value，OTel Attributes 形态）。 */
export interface GenAiSpanAttributes {
  'gen_ai.system': 'agentcorp';
  'gen_ai.operation.name': string;
  'gen_ai.agent.name': string;
  'gen_ai.agent.role': string;
  'gen_ai.conversation.id': string;
  'gen_ai.request.model'?: string;
  /** Skill 调用证据（自定义扩展走 agentcorp.* 命名空间，不占用 gen_ai.* 保留域） */
  'agentcorp.skill.id'?: string;
  'agentcorp.loop.phase': string;
  'agentcorp.loop.summary': string;
  'agentcorp.loop.ts': number;
}

/** OTel GenAI metric 属性集（token / 成本归因）。 */
export interface GenAiMetricAttributes {
  'gen_ai.system': 'agentcorp';
  'gen_ai.conversation.id': string;
  'gen_ai.agent.id': string;
  'gen_ai.request.model'?: string;
  'gen_ai.usage.input_tokens': number;
  'gen_ai.usage.output_tokens': number;
  'gen_ai.usage.total_tokens': number;
  'gen_ai.usage.cost_usd': number;
  'agentcorp.usage.timestamp': string;
}

export interface SpanContext {
  /** 一次闭环 run / 会话的关联 id（跨步骤一致） */
  conversationId: string;
  /** 本次调用的模型（可选） */
  model?: string;
}

/** LoopStep → OTel GenAI span 属性。 */
export function toGenAiSpan(step: LoopStep, ctx: SpanContext): GenAiSpanAttributes {
  return {
    'gen_ai.system': 'agentcorp',
    'gen_ai.operation.name': step.skill ? 'invoke_skill' : `loop.${step.phase}`,
    'gen_ai.agent.name': step.agentName,
    'gen_ai.agent.role': step.agentRole,
    'gen_ai.conversation.id': ctx.conversationId,
    ...(ctx.model ? { 'gen_ai.request.model': ctx.model } : {}),
    ...(step.skill ? { 'agentcorp.skill.id': step.skill } : {}),
    'agentcorp.loop.phase': step.phase,
    'agentcorp.loop.summary': step.summary,
    'agentcorp.loop.ts': step.ts,
  };
}

/** 一次 run 的全部 LoopStep → span 序列（同一 conversation id 关联）。 */
export function toGenAiTrace(steps: LoopStep[], ctx: SpanContext): GenAiSpanAttributes[] {
  return steps.map((s) => toGenAiSpan(s, ctx));
}

/** token 用量记录（与 judgeClient.TokenUsageHistoryEntryLike 结构对齐的最小输入）。 */
export interface TokenUsageInput {
  timestamp: string;
  sessionId: string;
  agentId: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

/** token 用量 → OTel GenAI metric 属性（成本/延迟可归因到 agent + conversation）。 */
export function toGenAiMetric(entry: TokenUsageInput): GenAiMetricAttributes {
  const input = entry.inputTokens ?? 0;
  const output = entry.outputTokens ?? 0;
  return {
    'gen_ai.system': 'agentcorp',
    'gen_ai.conversation.id': entry.sessionId,
    'gen_ai.agent.id': entry.agentId,
    ...(entry.model ? { 'gen_ai.request.model': entry.model } : {}),
    'gen_ai.usage.input_tokens': input,
    'gen_ai.usage.output_tokens': output,
    'gen_ai.usage.total_tokens': entry.totalTokens ?? input + output,
    'gen_ai.usage.cost_usd': entry.costUsd ?? 0,
    'agentcorp.usage.timestamp': entry.timestamp,
  };
}
