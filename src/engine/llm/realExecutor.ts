/**
 * src/engine/llm/realExecutor.ts
 * 真实 LLM 执行适配器（前端侧）。
 *
 * 前端只调同源 /api/llm/chat（由 Vite dev 中间件 vite-plugin-llm-proxy 代理到
 * 真实 LLM，如火山方舟 Ark）。API key 只在服务端读取，前端绝不接触。
 *
 * 这是「真实执行」而非 mock：把任务内容作为 prompt 交给真实模型，返回模型的
 * 真实产出；失败（未配置 / 上游报错 / 空产出）都如实抛出，交给 autoWorker 的
 * S9 重试与 failed 流转处理，绝不静默成功。
 */

export interface RealExecutionResult {
  /** 模型真实产出文本 */
  content: string;
  finishReason: string | null;
  usage: unknown;
}

/** 判断真实执行后端是否可用（探测代理是否配置了 key）。 */
export async function isRealExecutorAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/api/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'ping' }),
    });
    // 503 = 未配置；其余（含 200/400）都说明代理在线且已配置。
    return res.status !== 503;
  } catch {
    return false;
  }
}

/**
 * 让真实模型执行一段任务 prompt。
 * @throws Error 当未配置 / 上游失败 / 无真实产出时。
 */
export async function runRealExecution(input: {
  message: string;
  system?: string;
  maxTokens?: number;
}): Promise<RealExecutionResult> {
  const res = await fetch('/api/llm/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const data = (await res.json().catch(() => ({}))) as {
    content?: string;
    finishReason?: string | null;
    usage?: unknown;
    error?: string;
    detail?: unknown;
  };

  if (!res.ok) {
    const detail =
      typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail ?? data.error ?? {});
    throw new Error(`真实执行失败（${res.status} ${data.error ?? ''}）：${detail}`.trim());
  }

  const content = (data.content ?? '').trim();
  if (!content) {
    throw new Error('真实执行返回空产出（模型无有效 content）');
  }

  return {
    content,
    finishReason: data.finishReason ?? null,
    usage: data.usage ?? null,
  };
}

/** 默认单次 chat 调用超时：上游挂起时不能让用户发送态永久卡死。 */
export const REAL_CHAT_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 多轮消息版真实执行（供多 agent A2A 协作编排使用）。
 * 直接把完整 messages 交给真实模型，返回真实文本产出。
 * 带超时（默认 120s，可用 timeoutMs 覆盖）：超时抛出明确中文错误，
 * 视图的 catch 会提示用户、编排器会把对应子任务走失败改派路径。
 * @throws Error 当未配置 / 上游失败 / 空产出 / 超时时。
 */
export async function runRealChat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  maxTokens = 2048,
  timeoutMs = REAL_CHAT_DEFAULT_TIMEOUT_MS,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/api/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // AbortSignal.timeout 触发时 fetch 以 TimeoutError 拒绝（旧环境可能叫 AbortError）
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`模型响应超时（${Math.round(timeoutMs / 1000)}s），请重试`, { cause: err });
    }
    throw err;
  }
  const data = (await res.json().catch(() => ({}))) as {
    content?: string;
    error?: string;
    detail?: unknown;
  };
  if (!res.ok) {
    const detail =
      typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail ?? data.error ?? {});
    throw new Error(`真实执行失败（${res.status} ${data.error ?? ''}）：${detail}`.trim());
  }
  const content = (data.content ?? '').trim();
  if (!content) throw new Error('真实执行返回空产出（模型无有效 content）');
  return content;
}
