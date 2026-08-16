/**
 * src/lib/task-notify.ts
 * 渲染进程侧的任务终态通知入口：转发给主进程弹系统通知，
 * 点击通知跳回看板并选中对应任务（/kanban?task=<id>）。
 * 浏览器预览 / 通知不可用时静默降级，绝不影响任务主流程。
 */
import { invokeIpc } from '@/lib/api-client';

export type TaskNotifyKind = 'done' | 'failed';

export function notifyTaskTerminal(taskId: string, kind: TaskNotifyKind, taskTitle: string, detail?: string): void {
  const title = kind === 'done' ? '任务完成，待验收' : '任务失败';
  const body = detail ? `${taskTitle}\n${detail}`.slice(0, 180) : taskTitle;
  void invokeIpc('task:notify', { taskId, title, body }).catch(() => {
    /* 浏览器预览或无通知权限时忽略 */
  });
}
