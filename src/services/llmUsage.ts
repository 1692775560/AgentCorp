/**
 * src/services/llmUsage.ts
 * LLM token 用量采集（渲染层）+ 成本估算 + 聚合纯函数。
 *
 * 数据流：runRealChat / runRealExecution 拿到上游 usage 后调 trackLlmUsage
 * （fire-and-forget，失败静默，绝不阻塞聊天主流程）→ POST /api/llm-usage
 * 由主进程 append 到 usage-log.json；成本看板页 GET 全量回来前端聚合。
 */
import type { LlmCallContext, LlmUsageRecord } from '@/types/llm-usage';
import { setLlmUsageReporter } from '@/engine/llm/realExecutor';

export type { LlmCallContext, LlmUsageRecord };

export interface ParsedChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function readTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 解析 OpenAI 兼容响应里的 usage 字段。
 * 代理（vite-plugin-llm-proxy）原样透传上游 DeepSeek 的
 * { prompt_tokens, completion_tokens, total_tokens }；这里顺带兼容 camelCase。
 * 无 usage 或字段全非正数时返回 null（该次调用不计入）。
 */
export function parseChatUsage(usage: unknown): ParsedChatUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const promptTokens = readTokenCount(u.prompt_tokens ?? u.promptTokens);
  const completionTokens = readTokenCount(u.completion_tokens ?? u.completionTokens);
  const totalTokens = readTokenCount(u.total_tokens ?? u.totalTokens) || promptTokens + completionTokens;
  if (totalTokens <= 0) return null;
  return { promptTokens, completionTokens, totalTokens };
}

/**
 * DeepSeek 官方定价（人民币 / 百万 token，标准时段）：
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing （2025-02 调价后）
 * - deepseek-chat：输入（缓存未命中）¥2，输出 ¥8
 * - deepseek-reasoner：输入 ¥4，输出 ¥16
 * 缓存命中的输入实际更便宜（¥0.5），上游 usage 未细分命中量，统一按未命中估价（偏保守）。
 */
export const DEEPSEEK_PRICE_PER_MILLION_CNY: Record<string, { input: number; output: number }> = {
  'deepseek-chat': { input: 2, output: 8 },
  'deepseek-reasoner': { input: 4, output: 16 },
};

/** 模型未识别时的兜底价（按 deepseek-chat 估，保证 0 配置也有估值）。 */
const FALLBACK_PRICE = DEEPSEEK_PRICE_PER_MILLION_CNY['deepseek-chat'];

/** 估算单次调用成本（元）。model 为空或未收录时按兜底价估。 */
export function estimateCostCny(
  usage: Pick<ParsedChatUsage, 'promptTokens' | 'completionTokens'>,
  model?: string | null,
): number {
  const price = (model && DEEPSEEK_PRICE_PER_MILLION_CNY[model]) || FALLBACK_PRICE;
  return (usage.promptTokens / 1_000_000) * price.input
    + (usage.completionTokens / 1_000_000) * price.output;
}

/** 估算一条用量记录的成本（元）。 */
export function estimateRecordCostCny(record: LlmUsageRecord): number {
  return estimateCostCny(record, record.model);
}

/**
 * 采集一次 LLM 调用的用量并上报主进程持久化。
 * fire-and-forget：解析不出 usage 直接跳过；上报失败静默（console.debug 留痕），
 * 绝不抛出、绝不阻塞聊天主流程。
 */
export function trackLlmUsage(
  usage: unknown,
  model: string | null | undefined,
  ctx?: LlmCallContext,
): void {
  const parsed = parseChatUsage(usage);
  if (!parsed) return;
  const record: LlmUsageRecord = {
    ts: new Date().toISOString(),
    ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx?.teamId ? { teamId: ctx.teamId } : {}),
    ...(ctx?.taskId ? { taskId: ctx.taskId } : {}),
    ...(model ? { model } : {}),
    ...parsed,
  };
  void (async () => {
    try {
      // 动态引入 host-api：纯函数侧（解析/估算/聚合）不被 IPC 依赖链污染，便于 node 环境单测。
      const { hostApiFetch } = await import('@/lib/host-api');
      await hostApiFetch('/api/llm-usage', {
        method: 'POST',
        body: JSON.stringify(record),
      });
    } catch (err) {
      // 采集失败静默：浏览器预览模式（无 Host API）或主进程不可达时正常走到这里。
      console.debug('[llmUsage] 用量上报失败（已忽略）:', err instanceof Error ? err.message : err);
    }
  })();
}

/**
 * 把 trackLlmUsage 注入 realExecutor 的上报 sink。
 * 渲染层启动时（App.tsx）调用一次；幂等。
 */
export function initLlmUsageReporting(): void {
  setLlmUsageReporter(trackLlmUsage);
}

/* ─── 看板聚合纯函数 ─── */
export type UsageTimeRange = 'today' | '7d' | 'all';

/** 按时间范围过滤记录。now 可注入便于测试。 */
export function filterUsageByRange(
  records: LlmUsageRecord[],
  range: UsageTimeRange,
  now: number = Date.now(),
): LlmUsageRecord[] {
  if (range === 'all') return records;
  const start = new Date(now);
  if (range === 'today') {
    start.setHours(0, 0, 0, 0);
  } else {
    // 7d：含今天在内的最近 7 个自然日
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
  }
  const cutoff = start.getTime();
  return records.filter((r) => {
    const ts = new Date(r.ts).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

export type UsageGroupBy = 'agent' | 'team' | 'task';

export interface UsageGroupRow {
  key: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costCny: number;
}

/** 按 agent / team / task 归集用量，按 totalTokens 降序。无归属的归入「未归属」。 */
export function aggregateUsage(records: LlmUsageRecord[], groupBy: UsageGroupBy): UsageGroupRow[] {
  const pick = (r: LlmUsageRecord): string | undefined =>
    groupBy === 'agent' ? r.agentId : groupBy === 'team' ? r.teamId : r.taskId;
  const map = new Map<string, UsageGroupRow>();
  for (const r of records) {
    const key = pick(r) || '未归属';
    const row = map.get(key) ?? {
      key,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costCny: 0,
    };
    row.calls += 1;
    row.promptTokens += r.promptTokens;
    row.completionTokens += r.completionTokens;
    row.totalTokens += r.totalTokens;
    row.costCny += estimateRecordCostCny(r);
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}
