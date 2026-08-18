/**
 * src/types/llm-usage.ts
 * LLM 调用 token 用量记录（成本看板）的共享类型：
 * 渲染层（realExecutor → llmUsage 服务）上报、主进程（usage-log.json）持久化共用。
 */

/**
 * 一次 LLM 调用的归属上下文。
 * 由编排器的 chat 包装在调用处闭包注入（runRealChat 第三/四参），
 * 不用模块级全局上下文——编排是 Promise.all 并发，全局单上下文会互相串扰，
 * 而浏览器渲染进程没有 AsyncLocalStorage。
 */
export interface LlmCallContext {
  taskId?: string;
  teamId?: string;
  agentId?: string;
}

/** 一次 LLM 调用的 token 用量记录（append 到主进程 usage-log.json）。 */
export interface LlmUsageRecord {
  /** ISO 时间戳 */
  ts: string;
  agentId?: string;
  teamId?: string;
  taskId?: string;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
