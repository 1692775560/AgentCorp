/**
 * _deps/transport.ts — pixel-agents transport 的最小桩。
 *
 * 原 transport 是 VS Code webview ↔ 扩展主进程的消息通道。AgentCorp 里没有该通道，
 * office 引擎只用到 transport.send({ type: 'saveAgentSeats', seats })（保存座位布局），
 * 在 web 内嵌场景下无需持久化到扩展端，故桩成 no-op。
 */
export interface MessageTransport {
  send: (message: unknown) => void;
}

export const transport: MessageTransport = {
  send: () => {
    /* no-op：AgentCorp 内嵌像素办公室不回传消息到扩展主进程 */
  },
};
