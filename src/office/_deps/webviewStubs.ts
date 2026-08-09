/**
 * _deps/webviewStubs.ts — pixel-agents webview hooks 中被 office 引擎引用的类型桩。
 *
 * office 只引用了这些 hook 导出的「类型」（AgentTaskStatus / SubagentCharacter），
 * 不引用其运行时逻辑，故此处仅提供等价类型定义，避免拉入整套 webview 消息 hook。
 */

/** agent 任务状态机（渲染头顶任务气泡用）。 */
export type TaskState = 'idle' | 'pending' | 'running' | 'done' | 'error';

export interface AgentTaskStatus {
  agentId: number;
  state: TaskState;
  /** Short description shown in head bubble */
  label: string;
  sessionKey?: string;
  startedAt?: number;
  completedAt?: number;
}

/** 子 agent 精灵（工具调用衍生的临时角色）。 */
export interface SubagentCharacter {
  id: number;
  parentAgentId: number;
  parentToolId: string;
  label: string;
}
