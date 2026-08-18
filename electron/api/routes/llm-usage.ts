/**
 * electron/api/routes/llm-usage.ts
 * LLM token 用量采集路由（成本看板）：
 * - POST /api/llm-usage  追加一条（或 { entries: [...] } 一批）用量记录；
 * - GET  /api/llm-usage?since=<ISO>  全量返回（可选 since 过滤），前端自行聚合。
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { appendLlmUsageRecords, listLlmUsageRecords } from '../../utils/llm-usage-log';
import type { LlmUsageRecord } from '../../../src/types/llm-usage';

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 校验并规范化一条上报记录；字段非法返回 null。 */
function normalizeRecord(input: unknown): LlmUsageRecord | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const promptTokens = asTokenCount(raw.promptTokens);
  const completionTokens = asTokenCount(raw.completionTokens);
  if (promptTokens == null || completionTokens == null) return null;
  const totalTokens = asTokenCount(raw.totalTokens) ?? promptTokens + completionTokens;
  return {
    ts: asNonEmptyString(raw.ts) ?? new Date().toISOString(),
    ...(asNonEmptyString(raw.agentId) ? { agentId: asNonEmptyString(raw.agentId) } : {}),
    ...(asNonEmptyString(raw.teamId) ? { teamId: asNonEmptyString(raw.teamId) } : {}),
    ...(asNonEmptyString(raw.taskId) ? { taskId: asNonEmptyString(raw.taskId) } : {}),
    ...(asNonEmptyString(raw.model) ? { model: asNonEmptyString(raw.model) } : {}),
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

export async function handleLlmUsageRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname !== '/api/llm-usage') return false;

  if (req.method === 'GET') {
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw ? new Date(sinceRaw).getTime() : NaN;
    let entries = await listLlmUsageRecords();
    if (Number.isFinite(since)) {
      entries = entries.filter((e) => new Date(e.ts).getTime() >= since);
    }
    sendJson(res, 200, { entries });
    return true;
  }

  if (req.method === 'POST') {
    const body = await parseJsonBody<unknown>(req);
    const rawList = Array.isArray((body as { entries?: unknown[] })?.entries)
      ? (body as { entries: unknown[] }).entries
      : [body];
    const records = rawList
      .map(normalizeRecord)
      .filter((r): r is LlmUsageRecord => r !== null);
    if (records.length === 0) {
      sendJson(res, 400, { success: false, error: 'invalid usage record' });
      return true;
    }
    const appended = await appendLlmUsageRecords(records);
    sendJson(res, 201, { success: true, appended });
    return true;
  }

  sendJson(res, 405, { success: false, error: 'method_not_allowed' });
  return true;
}
