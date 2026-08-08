/**
 * src/lib/task-approval-preview-mock.ts
 * Web 预览用「任务看板 + 审批」内存 mock 层。
 *
 * 背景：任务/审批 store 全部走 hostApiFetch('/api/tasks*' | '/api/approvals*')，
 * 那些端点只存在于 Electron 主进程 / gateway。web 预览里发到 127.0.0.1:3210 会失败，
 * 导致「看板消失、任务无法完成、审批 list 为空」。
 *
 * 本模块在 isBrowserPreviewMode() 下拦截这些请求，用纯前端内存实现完整闭环：
 *   - GET  /api/tasks                          → 快照（首次按当前入职花名册自动 seed）
 *   - POST /api/tasks                          → 新建
 *   - PUT  /api/tasks/:id                       → 更新（含状态流转）
 *   - DELETE /api/tasks/:id                     → 删除
 *   - POST /api/tasks/:id/execution/start       → 开始执行
 *   - POST /api/tasks/:id/execution/events      → 追加执行事件（推进 workState / 审批）
 *   - GET  /api/approvals                       → 待审批 list（由 waiting_approval 任务派生）
 *   - POST /api/approvals/approve|reject        → 审批决策（回写对应任务）
 *
 * 仅前端内存，不落库；Electron 桌面端仍走真实 host API，与本模块无关。
 */
import type {
  CreateTaskRequest,
  KanbanTask,
  StartTaskExecutionRequest,
  TaskExecutionEventInput,
  TaskExecutionEvent,
  TasksSnapshot,
  TaskStatus,
} from '@/types/task';
import type { ApprovalItem } from '@/stores/approvals';
import { OFFICE_DEPTS, computeOfficeRoster, type OfficeEmployee } from '@/engine/office/assignment';

// ── 内存状态 ────────────────────────────────────────────────
let tasks: KanbanTask[] = [];
let approvals: ApprovalItem[] = [];
let seeded = false;

function now(): string {
  return new Date().toISOString();
}

function iso(minsAgo: number): string {
  return new Date(Date.now() - minsAgo * 60_000).toISOString();
}

/** 从评估/agents store 读取当前入职花名册（懒加载避免循环依赖）。 */
function readRoster(): OfficeEmployee[] {
  try {
    // 运行时按需引入，避免与 store 形成静态循环依赖
    const { useEvaluationStore } = require('@/stores/evaluation') as typeof import('@/stores/evaluation');
    const { useAgentsStore } = require('@/stores/agents') as typeof import('@/stores/agents');
    const profiles = useEvaluationStore.getState().profiles;
    const agents = useAgentsStore.getState().agents;
    return computeOfficeRoster(profiles, agents);
  } catch {
    return [];
  }
}

// ── 案件模板（按部门给出有真实执行过程的示例任务） ──────────────
interface TaskTemplate {
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  status: TaskStatus;
  events: Array<{ minsAgo: number; type: string; status: KanbanTask['workState']; content: string }>;
  /** 是否处于「待审批」——会生成一条审批 list 记录 */
  needsApproval?: { summary: string; command: string };
  workResult?: string;
}

function templatesForDept(dept: OfficeEmployee['dept']): TaskTemplate[] {
  const label = OFFICE_DEPTS[dept].label;
  if (dept === 'engineering') {
    return [
      {
        title: '实现登录鉴权接口',
        description: `${label} · 为后台搭建 JWT 登录 / 刷新令牌接口，并补充单元测试。`,
        priority: 'high',
        status: 'in-progress',
        events: [
          { minsAgo: 42, type: 'start', status: 'starting', content: '接单：拆解需求为 3 个子任务' },
          { minsAgo: 38, type: 'tool', status: 'working', content: '编写 src/routes/auth.ts —— 登录 / 刷新端点' },
          { minsAgo: 31, type: 'tool', status: 'working', content: '编写 src/middleware/jwt.ts —— 令牌校验中间件' },
          { minsAgo: 24, type: 'tool', status: 'working', content: '运行 npm test —— 12 passing' },
        ],
      },
      {
        title: '上线部署到生产环境',
        description: `${label} · 将 auth 服务部署到生产集群（需人工审批高危命令）。`,
        priority: 'high',
        status: 'review',
        events: [
          { minsAgo: 18, type: 'start', status: 'starting', content: '准备部署清单' },
          { minsAgo: 12, type: 'tool', status: 'working', content: '构建镜像 auth-service:1.4.0 完成' },
          { minsAgo: 6, type: 'approval', status: 'waiting_approval', content: '请求执行高危命令：kubectl apply -f prod/' },
        ],
        needsApproval: { summary: '部署到生产：kubectl apply -f prod/', command: 'kubectl apply -f prod/' },
      },
    ];
  }
  if (dept === 'design') {
    return [
      {
        title: '设计系统组件改版',
        description: `${label} · 重构按钮 / 输入框 / 卡片的视觉规范并产出 Figma 交付件。`,
        priority: 'medium',
        status: 'in-progress',
        events: [
          { minsAgo: 55, type: 'start', status: 'starting', content: '梳理现有组件清单与不一致项' },
          { minsAgo: 40, type: 'tool', status: 'working', content: '产出新按钮态（默认/悬停/禁用）' },
          { minsAgo: 22, type: 'tool', status: 'working', content: '导出设计 token → tokens.json' },
        ],
      },
    ];
  }
  if (dept === 'pm') {
    return [
      {
        title: 'Q3 路线图与优先级排期',
        description: `${label} · 汇总各部门诉求，输出 Q3 路线图与 RICE 优先级。`,
        priority: 'medium',
        status: 'done',
        workResult: '已交付 Q3 路线图文档，含 8 个 Epic 的 RICE 排序与里程碑。',
        events: [
          { minsAgo: 120, type: 'start', status: 'starting', content: '收集三部门需求输入' },
          { minsAgo: 90, type: 'tool', status: 'working', content: 'RICE 打分并排序' },
          { minsAgo: 60, type: 'done', status: 'done', content: '输出路线图文档 v1，交付评审' },
        ],
      },
    ];
  }
  return [];
}

let taskSeq = 0;
function nextId(prefix: string): string {
  taskSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${taskSeq}`;
}

function buildTaskFromTemplate(emp: OfficeEmployee, tpl: TaskTemplate): KanbanTask {
  const id = nextId('task');
  const events: TaskExecutionEvent[] = tpl.events.map((e) => ({
    type: e.type,
    createdAt: iso(e.minsAgo),
    status: e.status,
    content: e.content,
    actorId: emp.agentId,
  }));
  const lastEvent = tpl.events[tpl.events.length - 1];
  const waiting = Boolean(tpl.needsApproval);
  const workState: KanbanTask['workState'] = tpl.status === 'done'
    ? 'done'
    : waiting
      ? 'waiting_approval'
      : 'working';
  const meta = OFFICE_DEPTS[emp.dept];
  return {
    id,
    title: tpl.title,
    description: tpl.description,
    status: tpl.status,
    priority: tpl.priority,
    assigneeId: emp.agentId,
    assigneeRole: meta.label,
    workState,
    teamId: emp.dept,
    teamName: meta.label,
    isTeamTask: false,
    executionEvents: events,
    latestInternalExcerpt: lastEvent
      ? { content: lastEvent.content, createdAt: iso(lastEvent.minsAgo) }
      : undefined,
    approvalState: waiting ? { state: 'waiting_user', updatedAt: now() } : { state: 'idle' },
    blocker: waiting
      ? { state: 'waiting_approval', summary: tpl.needsApproval!.summary, updatedAt: now() }
      : undefined,
    workResult: tpl.workResult,
    createdAt: iso(180),
    updatedAt: lastEvent ? iso(lastEvent.minsAgo) : now(),
  };
}

function seedIfNeeded(): void {
  if (seeded) return;
  seeded = true;
  const roster = readRoster();
  if (roster.length === 0) {
    // 花名册尚未就绪：不锁定，下次访问再尝试 seed
    seeded = false;
    return;
  }
  const byDept = new Map<OfficeEmployee['dept'], OfficeEmployee[]>();
  for (const emp of roster) {
    const list = byDept.get(emp.dept) ?? [];
    list.push(emp);
    byDept.set(emp.dept, list);
  }
  for (const [dept, members] of byDept) {
    const tpls = templatesForDept(dept);
    tpls.forEach((tpl, i) => {
      const emp = members[i % members.length];
      if (!emp) return;
      const task = buildTaskFromTemplate(emp, tpl);
      tasks.push(task);
      if (tpl.needsApproval) {
        approvals.push({
          id: nextId('appr'),
          agentId: emp.agentId,
          state: 'waiting_user',
          status: 'pending',
          command: tpl.needsApproval.command,
          reason: tpl.needsApproval.summary,
          prompt: `${emp.name} 请求：${tpl.needsApproval.summary}`,
          createdAt: now(),
          requestedAt: now(),
          toolInput: { taskId: task.id },
        });
      }
    });
  }
}

// ── 请求处理 ────────────────────────────────────────────────
function snapshot(task?: KanbanTask): TasksSnapshot {
  return task ? { tasks, task } : { tasks };
}

function findTask(id: string): KanbanTask | undefined {
  return tasks.find((t) => t.id === id);
}

function statusToWorkState(status: TaskStatus): KanbanTask['workState'] {
  if (status === 'done') return 'done';
  if (status === 'review') return 'waiting_approval';
  if (status === 'in-progress') return 'working';
  return 'idle';
}

/** 判断路径是否属于本 mock 层。 */
export function isTaskApprovalMockPath(path: string): boolean {
  const p = path.split('?')[0];
  return p.startsWith('/api/tasks') || p.startsWith('/api/approvals');
}

/**
 * 处理被拦截的任务/审批请求。返回值即 hostApiFetch 的解析结果。
 */
export function handleTaskApprovalMock<T>(path: string, init?: RequestInit): T {
  seedIfNeeded();
  const method = (init?.method || 'GET').toUpperCase();
  const p = path.split('?')[0];
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;

  // ── /api/approvals ──
  if (p === '/api/approvals') return { approvals } as unknown as T;
  if (p === '/api/approvals/approve' || p === '/api/approvals/reject') {
    const decision = p.endsWith('approve') ? 'approved' : 'rejected';
    const id = body?.approvalId as string | undefined;
    const item = approvals.find((a) => a.id === id);
    if (item) {
      item.state = decision;
      item.status = decision;
      item.decision = decision;
      item.updatedAt = now();
      const taskId = (item.toolInput?.taskId as string | undefined);
      const task = taskId ? findTask(taskId) : undefined;
      if (task) {
        task.approvalState = { state: decision === 'approved' ? 'approved' : 'rejected', updatedAt: now() };
        task.blocker = undefined;
        task.workState = decision === 'approved' ? 'working' : 'failed';
        task.status = decision === 'approved' ? 'in-progress' : task.status;
        task.executionEvents = [
          ...(task.executionEvents ?? []),
          {
            type: 'approval',
            createdAt: now(),
            status: task.workState,
            content: decision === 'approved' ? `审批通过：${item.reason ?? ''}` : `审批驳回：${body?.reason ?? ''}`,
          },
        ];
        task.updatedAt = now();
      }
    }
    // 已决策的从待办 list 移除
    approvals = approvals.filter((a) => a.state === 'waiting_user' || a.status === 'pending');
    return undefined as T;
  }

  // ── /api/tasks ──
  if (p === '/api/tasks' && method === 'GET') return snapshot() as unknown as T;

  if (p === '/api/tasks' && method === 'POST') {
    const input = body as CreateTaskRequest;
    const task: KanbanTask = {
      id: nextId('task'),
      title: input.title,
      description: input.description,
      status: 'todo',
      priority: input.priority,
      assigneeId: input.assigneeId,
      assigneeRole: input.assigneeRole,
      workState: 'idle',
      teamId: input.teamId,
      teamName: input.teamName,
      isTeamTask: false,
      executionEvents: [],
      approvalState: { state: 'idle' },
      createdAt: now(),
      updatedAt: now(),
      deadline: input.deadline,
    };
    tasks = [task, ...tasks];
    return snapshot(task) as unknown as T;
  }

  const idMatch = p.match(/^\/api\/tasks\/([^/]+)(\/.*)?$/);
  if (idMatch) {
    const taskId = decodeURIComponent(idMatch[1]);
    const sub = idMatch[2] ?? '';
    const task = findTask(taskId);

    if (sub === '' && method === 'PUT') {
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const updates = body as Partial<KanbanTask>;
      Object.assign(task, updates);
      if (updates.status) task.workState = statusToWorkState(updates.status);
      task.updatedAt = now();
      return snapshot(task) as unknown as T;
    }

    if (sub === '' && method === 'DELETE') {
      tasks = tasks.filter((t) => t.id !== taskId);
      return snapshot() as unknown as T;
    }

    if (sub === '/execution/start' && method === 'POST') {
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const input = body as StartTaskExecutionRequest;
      task.workState = 'working';
      task.status = task.status === 'todo' ? 'in-progress' : task.status;
      task.workStartedAt = input.startedAt ?? now();
      task.canonicalExecution = {
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        status: 'active',
        startedAt: task.workStartedAt,
        agentId: input.agentId,
      };
      task.executionEvents = [
        ...(task.executionEvents ?? []),
        { type: 'start', createdAt: now(), status: 'starting', content: '开始执行任务' },
      ];
      task.updatedAt = now();
      return snapshot(task) as unknown as T;
    }

    if (sub === '/execution/events' && method === 'POST') {
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const input = body as TaskExecutionEventInput;
      const event: TaskExecutionEvent = {
        type: input.type,
        createdAt: input.createdAt ?? now(),
        status: input.status,
        content: input.content,
        sessionKey: input.sessionKey,
        actorId: input.actorId,
      };
      task.executionEvents = [...(task.executionEvents ?? []), event];
      if (input.status) task.workState = input.status;
      if (input.content) {
        task.latestInternalExcerpt = { content: input.content, createdAt: event.createdAt };
      }
      if (input.status === 'done') task.status = 'done';
      task.updatedAt = now();
      return snapshot(task) as unknown as T;
    }
  }

  // 未识别的任务/审批子路径：返回当前快照，避免抛错阻断 UI
  return snapshot() as unknown as T;
}

/** 供调试/重置（例如花名册变化后想重新 seed）。 */
export function resetTaskApprovalMock(): void {
  tasks = [];
  approvals = [];
  seeded = false;
  taskSeq = 0;
}
