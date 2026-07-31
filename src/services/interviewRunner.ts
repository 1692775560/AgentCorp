/**
 * src/services/interviewRunner.ts
 * 面试提问的「agent 回答通道」（模块 B · 设计 §4.1）。
 *
 * 双模式（真实优先、降级不阻塞）：
 * 1. agent  —— 经 `gateway:rpc → chat.send` 真实调度候选 agent 回答，
 *              取回 runId，再从 `chat.history` 捞出本轮的 assistant 回复；
 * 2. manual —— 网关未连接 / 调度失败 / 超时时，返回 mode='manual'，
 *              UI 引导 HR「手动粘贴回答」，面试流程照常推进（离线可用）。
 *
 * 本模块只负责「发问 → 拿回答」，不做任何评分/落库（职责由 stores/interview.ts 承担）。
 */
import { invokeIpc } from '@/lib/api-client';
import type { RawMessage, ContentBlock } from '@/stores/chat/types';

/** 一次提问的结果 */
export interface AskResult {
  /** 实际生效的通道 */
  mode: 'agent' | 'manual';
  /** 真实调度主键（chat.send 返回），手动模式为 null */
  runId: string | null;
  /** agent 回答原文；手动模式为空串（等待 HR 粘贴） */
  replyText: string;
  /** 回答时延（ms）；手动模式为 null */
  latencyMs: number | null;
  /** 失败原因（降级时填充，用于 UI 提示） */
  error?: string;
}

/** 提问入参 */
export interface AskParams {
  /** 目标 agent 的会话键（通常取 AgentSummary.mainSessionKey） */
  sessionKey: string;
  /** 提问文本（已渲染占位符） */
  question: string;
  /** 调度超时（ms），默认 120s，与 chat 主链路一致 */
  timeoutMs?: number;
  /** 取回回复的最大等待轮次（每轮间隔 pollIntervalMs） */
  maxPolls?: number;
  /** 轮询间隔（ms） */
  pollIntervalMs?: number;
}

/** chat.send / chat.history 的统一 RPC 响应形状 */
interface RpcEnvelope<T> {
  success: boolean;
  result?: T;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_POLLS = 20;
const DEFAULT_POLL_INTERVAL_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 生成幂等键（与 chat 主链路同风格，避免网关重复投递） */
function makeIdempotencyKey(): string {
  return `interview-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 把 chat.history 的 content（string | ContentBlock[]）拍平成纯文本 */
export function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    const block = raw as ContentBlock;
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * 从 chat.history 中取「本次提问之后」的最后一条 assistant 文本回复。
 * @param sessionKey 会话键
 * @param sinceMs 提问发出的时间戳（ms），用于过滤历史旧消息
 */
export async function fetchLatestReply(
  sessionKey: string,
  sinceMs: number,
): Promise<string> {
  try {
    const res = (await invokeIpc('gateway:rpc', 'chat.history', {
      sessionKey,
      limit: 50,
    })) as RpcEnvelope<Record<string, unknown>>;
    if (!res?.success || !res.result) return '';
    const messages = Array.isArray(res.result.messages)
      ? (res.result.messages as RawMessage[])
      : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;
      // 网关时间戳可能是秒或毫秒；缺省则不做时间过滤（取最后一条）
      const ts = typeof msg.timestamp === 'number' ? normalizeTs(msg.timestamp) : null;
      if (ts !== null && ts < sinceMs) continue;
      const text = flattenContent(msg.content);
      if (text.length > 0) return text;
    }
    return '';
  } catch {
    return '';
  }
}

/** 时间戳归一化为毫秒 */
function normalizeTs(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

/**
 * 真实调度 agent 回答本题；失败时返回 manual 模式让 HR 手动粘贴。
 *
 * 说明：网关的 chat.send 可能在整段 agentic 对话结束后才返回，
 * 因此这里「先 send 取 runId，再轮询 history 捞回复」，
 * 即便 send 长时间阻塞，也能在其返回后立刻拿到答案。
 */
export async function askAgent(params: AskParams): Promise<AskResult> {
  const {
    sessionKey,
    question,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxPolls = DEFAULT_MAX_POLLS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = params;

  const startedAt = Date.now();
  const trimmed = question.trim();
  if (!sessionKey || trimmed.length === 0) {
    return {
      mode: 'manual',
      runId: null,
      replyText: '',
      latencyMs: null,
      error: '缺少会话键或提问内容，已降级为手动录入',
    };
  }

  let runId: string | null = null;
  try {
    const res = (await invokeIpc(
      'gateway:rpc',
      'chat.send',
      {
        sessionKey,
        message: trimmed,
        deliver: false,
        idempotencyKey: makeIdempotencyKey(),
      },
      timeoutMs,
    )) as RpcEnvelope<{ runId?: string }>;

    if (!res?.success) {
      return {
        mode: 'manual',
        runId: null,
        replyText: '',
        latencyMs: null,
        error: res?.error || 'chat.send 调度失败，已降级为手动录入',
      };
    }
    runId = res.result?.runId ?? null;
  } catch (e) {
    return {
      mode: 'manual',
      runId: null,
      replyText: '',
      latencyMs: null,
      error: e instanceof Error ? e.message : '网关不可用，已降级为手动录入',
    };
  }

  // 调度成功：轮询会话历史取回本轮回复
  for (let i = 0; i < maxPolls; i += 1) {
    const reply = await fetchLatestReply(sessionKey, startedAt);
    if (reply.length > 0) {
      return {
        mode: 'agent',
        runId,
        replyText: reply,
        latencyMs: Date.now() - startedAt,
      };
    }
    await sleep(pollIntervalMs);
  }

  // 已调度但没抓到文本回复：保留 runId，交给 HR 手动补录
  return {
    mode: 'manual',
    runId,
    replyText: '',
    latencyMs: Date.now() - startedAt,
    error: '已派发给 agent，但未取回文本回复，请手动粘贴或稍后重试',
  };
}

export const interviewRunner = { askAgent, fetchLatestReply, flattenContent };
