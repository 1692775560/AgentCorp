/**
 * src/lib/task-reconcile.ts
 * 轮询快照 reconcile：把全量拉回的 next 与现有 prev 按 id 对齐，
 * 内容未变的任务保留旧对象引用（深比较），整列表无变化时连数组引用也保留。
 *
 * 背景：autoWorker 每 3s 全量拉 /api/tasks 并 set 进 store。若每次都用
 * JSON 重新解析出的全新对象，所有订阅 tasks 的组件（看板/会话列表/任务会话）
 * 每轮全部重渲染，TaskCard 的 memo 也因引用全换而失效。引用保持后，
 * zustand 选择器的 Object.is 比较能让无变化的订阅直接跳过重渲染。
 *
 * 独立成纯函数模块：stores/approvals.ts 经 host-api ↔ 各 store 存在循环依赖，
 * 单测无法直接 import 真实模块；纯逻辑放这里可独立测试。
 */
import type { KanbanTask } from '@/types/task';

export function reconcileTasks(prev: KanbanTask[], next: KanbanTask[]): KanbanTask[] {
  if (prev.length === 0) return next; // 首次加载直接采用
  const prevById = new Map(prev.map((t) => [t.id, t]));
  let identical = prev.length === next.length;
  const merged = next.map((incoming, i) => {
    const existing = prevById.get(incoming.id);
    if (existing && JSON.stringify(existing) === JSON.stringify(incoming)) {
      if (prev[i] !== existing) identical = false; // 同集合但顺序变了
      return existing;
    }
    identical = false;
    return incoming;
  });
  return identical ? prev : merged;
}
