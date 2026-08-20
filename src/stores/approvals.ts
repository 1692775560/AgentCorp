import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { reconcileTasks } from '@/lib/task-reconcile';
import type {
  CreateTaskRequest,
  KanbanTask,
  StartTaskExecutionRequest,
  TaskExecutionEventInput,
  TaskStatus,
  TasksSnapshot,
} from '@/types/task';

export interface ApprovalItem {
  id: string;
  key?: string;
  sessionKey?: string;
  agentId?: string;
  state?: string;
  status?: string;
  decision?: string;
  command?: string;
  prompt?: string;
  reason?: string;
  createdAt?: string;
  requestedAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  toolInput?: Record<string, unknown>;
}

interface ApprovalsState {
  // Approvals fields
  approvals: ApprovalItem[];
  loading: boolean;
  error: string | null;
  fetchApprovals: () => Promise<void>;
  approveItem: (id: string, reason?: string) => Promise<void>;
  rejectItem: (id: string, reason: string) => Promise<void>;

  // Task fields
  tasks: KanbanTask[];
  tasksLoading: boolean;
  tasksError: string | null;
  fetchTasks: () => Promise<void>;
  createTask: (input: CreateTaskRequest) => Promise<KanbanTask>;
  updateTaskStatus: (taskId: string, status: TaskStatus) => Promise<KanbanTask>;
  updateTask: (taskId: string, updates: Partial<KanbanTask>) => Promise<KanbanTask>;
  deleteTask: (taskId: string) => Promise<void>;
  startTaskExecution: (taskId: string, input: StartTaskExecutionRequest) => Promise<KanbanTask>;
  appendTaskExecutionEvent: (taskId: string, input: TaskExecutionEventInput) => Promise<KanbanTask>;
}

function applyTaskSnapshotResponse(
  response: TasksSnapshot | undefined,
  currentTasks: KanbanTask[],
): KanbanTask[] {
  if (Array.isArray(response?.tasks)) {
    return response.tasks;
  }

  if (response?.task) {
    const nextTasks = [...currentTasks];
    const index = nextTasks.findIndex((task) => task.id === response.task?.id);
    if (index === -1) {
      nextTasks.push(response.task);
    } else {
      nextTasks[index] = response.task;
    }
    return nextTasks;
  }

  return currentTasks;
}

export const useApprovalsStore = create<ApprovalsState>((set, get) => ({
  // Approvals state
  approvals: [],
  loading: false,
  error: null,

  // Task state
  tasks: [],
  tasksLoading: false,
  tasksError: null,

  fetchApprovals: async () => {
    set({ loading: true, error: null });
    try {
      const data = await hostApiFetch<{ approvals?: ApprovalItem[] }>('/api/approvals');
      const raw = Array.isArray(data?.approvals) ? data.approvals : [];
      // Normalise: ensure every item has an id field
      const approvals = raw.map((item) => ({
        ...item,
        id: item.id ?? item.key ?? String(Math.random()),
      }));
      set({ approvals, loading: false });
    } catch (err) {
      set({ loading: false, error: String(err) });
    }
  },

  fetchTasks: async () => {
    // 该函数同时承担首次加载与 autoWorker 的 3s 后台轮询：
    // 只在无数据（首次加载）时亮 loading，避免每轮 true→false 闪烁
    // 让订阅 tasksLoading 的组件（看板）跟着多渲染两次。
    if (get().tasks.length === 0) {
      set({ tasksLoading: true, tasksError: null });
    }
    try {
      const snapshot = await hostApiFetch<TasksSnapshot>('/api/tasks');
      const incoming = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
      set((state) => ({
        tasks: reconcileTasks(state.tasks, incoming),
        tasksLoading: false,
        tasksError: null,
      }));
    } catch (err) {
      set({ tasksLoading: false, tasksError: String(err) });
    }
  },

  createTask: async (input) => {
    const snapshot = await hostApiFetch<TasksSnapshot>('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!snapshot?.task) {
      throw new Error('Missing task from createTask response');
    }
    set((state) => ({
      tasks: applyTaskSnapshotResponse(snapshot, state.tasks),
    }));
    return snapshot.task;
  },

  updateTaskStatus: async (taskId, status) => {
    return get().updateTask(taskId, { status });
  },

  updateTask: async (taskId, updates) => {
    const snapshot = await hostApiFetch<TasksSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!snapshot?.task) {
      throw new Error('Missing task from updateTask response');
    }
    set((state) => ({
      tasks: applyTaskSnapshotResponse(snapshot, state.tasks),
    }));
    return snapshot.task;
  },

  deleteTask: async (taskId) => {
    const snapshot = await hostApiFetch<TasksSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
    });
    set((state) => ({
      tasks: Array.isArray(snapshot?.tasks)
        ? snapshot.tasks
        : state.tasks.filter((task) => task.id !== taskId),
    }));
  },

  startTaskExecution: async (taskId, input) => {
    const snapshot = await hostApiFetch<TasksSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}/execution/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!snapshot?.task) {
      throw new Error('Missing task from startTaskExecution response');
    }
    set((state) => ({
      tasks: applyTaskSnapshotResponse(snapshot, state.tasks),
    }));
    return snapshot.task;
  },

  appendTaskExecutionEvent: async (taskId, input) => {
    // 未读角标：chat: 前缀事件是任务会话（team-task:<taskId>）里的对话消息，
    // 区别于 a2a: 等 trace 噪音（编排期间高频写回，绝不能按条计未读）。
    // 非当前会话时未读 +1；用户正在该任务会话里发消息时 currentSessionKey 命中，不自增。
    if (typeof input?.type === 'string' && input.type.startsWith('chat:')) {
      void import('./chat')
        .then(({ useChatStore }) => {
          const chat = useChatStore.getState();
          const sessionKey = `team-task:${taskId}`;
          if (chat.currentSessionKey !== sessionKey) {
            chat.updateSessionUnreadCount(sessionKey, 1);
          }
        })
        .catch(() => {});
    }
    const snapshot = await hostApiFetch<TasksSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}/execution/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!snapshot?.task) {
      throw new Error('Missing task from appendTaskExecutionEvent response');
    }
    set((state) => ({
      tasks: applyTaskSnapshotResponse(snapshot, state.tasks),
    }));
    return snapshot.task;
  },

  approveItem: async (id: string, reason?: string) => {
    await hostApiFetch('/api/approvals/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId: id, reason }),
    });
    await get().fetchApprovals();
  },

  rejectItem: async (id: string, reason: string) => {
    await hostApiFetch('/api/approvals/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId: id, reason }),
    });
    await get().fetchApprovals();
  },
}));
