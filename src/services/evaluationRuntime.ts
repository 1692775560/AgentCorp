/**
 * src/services/evaluationRuntime.ts
 * 评估运行时捕获点（T06）：将 runId 与 task/agent/session 关联落库。
 *
 * 这是「runId 锚定」契约的写入入口——Evaluation 页面在
 * gateway.rpc('chat.send') 拿到 runId 后立刻调用本函数，
 * 确保 RunTaskLink 在评估触发前已保存（仅 runId 关联落库，
 * 不修改 approvals.ts 的 task 模型；sessionKey/agentId 已在其 canonicalExecution 上）。
 */
import { saveForRun } from '@/services/runLinkStore';
import type { RunTaskLink } from '@/types/evaluation';

/** linkRunToTask 的关联上下文（不含 runId，由调用方从 chat.send 返回值提供） */
export interface RunLinkContext {
  taskId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
}

/**
 * 将一次执行的 runId 与 task/agent/session 绑定并落库。
 * @param runId 执行主键（来自 gateway.rpc('chat.send') 返回值，可能为 runId 或 run_id）
 * @param ctx 关联上下文
 * @returns 落库后的完整 RunTaskLink
 */
export async function linkRunToTask(
  runId: string,
  ctx: RunLinkContext,
): Promise<RunTaskLink> {
  return saveForRun(runId, {
    taskId: ctx.taskId,
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
  });
}
