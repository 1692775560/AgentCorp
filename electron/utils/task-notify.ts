/**
 * electron/utils/task-notify.ts
 * 任务终态系统通知（macOS 通知中心 / Windows  toast）。
 *
 * 点击通知 → 聚焦主窗口并向渲染进程发 'navigate' 事件跳到
 * /kanban?task=<id>，看板负责选中对应任务展开详情。
 * 通知不支持/窗口已销毁时静默返回 false，不抛错。
 */
import { BrowserWindow, Notification } from 'electron';

export interface TaskNotifyPayload {
  taskId: string;
  title: string;
  body: string;
}

export function showTaskNotification(
  win: BrowserWindow | null | undefined,
  payload: TaskNotifyPayload,
): boolean {
  if (!Notification.isSupported()) return false;
  const { taskId, title, body } = payload;
  const notification = new Notification({
    title,
    // macOS 通知正文过长会被截断，收敛到 200 字符
    body: body.slice(0, 200),
  });
  notification.on('click', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('navigate', `/kanban?task=${encodeURIComponent(taskId)}`);
    }
  });
  notification.show();
  return true;
}
