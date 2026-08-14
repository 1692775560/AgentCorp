/**
 * tests/unit/autoWorker.test.ts
 *
 * 自动任务 worker 单测（S8/S9/S10，合并到主干 tasks+execution 之上）：
 * - S8 自动领取：网关连上后，_tick 领取 status='todo' && workState='idle' 的任务并派活。
 * - S10 并发不重复：一次 tick 最多同时占 concurrency 个槽，且不会把同一条任务领两次。
 * - S9 自动重试：派活失败（gateway.rpc 抛错）→ 未达 maxAttempts 时任务被复位为 todo/idle 重排队；
 *   达到 maxAttempts 后不再重试（终止）。
 * - 结构性失败：任务无 assignee/sessionKey → failed，且不进入自动重试（避免死循环）。
 *
 * 隔离：mock '@/stores/gateway'、'@/stores/agents'、'@/stores/approvals'。
 * 不触真实网关、不触数据库、不引入 mock 业务数据。
 * 运行：pnpm test tests/unit/autoWorker.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KanbanTask } from '@/types/task';

// ── 受控的 store 替身 ───────────────────────────────────────────────
let gatewayState: 'running' | 'stopped' = 'running';
const rpcMock = vi.fn();

let agents: Array<{ id: string; name: string; mainSessionKey: string }> = [];

let tasks: KanbanTask[] = [];
const updateTaskMock = vi.fn(async (id: string, updates: Partial<KanbanTask>) => {
  const i = tasks.findIndex((t) => t.id === id);
  if (i >= 0) tasks[i] = { ...tasks[i], ...updates } as KanbanTask;
  return tasks[i];
});
const startExecMock = vi.fn(async (id: string) => {
  const i = tasks.findIndex((t) => t.id === id);
  if (i >= 0) tasks[i] = { ...tasks[i], workState: 'starting' } as KanbanTask;
  return tasks[i];
});
const fetchTasksMock = vi.fn(async () => {});

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      status: { state: gatewayState, port: 0 },
      rpc: rpcMock,
      init: vi.fn(),
    }),
  },
}));
vi.mock('@/stores/agents', () => ({
  useAgentsStore: { getState: () => ({ agents }) },
}));
vi.mock('@/stores/approvals', () => ({
  useApprovalsStore: {
    getState: () => ({
      tasks,
      fetchTasks: fetchTasksMock,
      updateTask: updateTaskMock,
      startTaskExecution: startExecMock,
    }),
  },
}));

import { useAutoWorkerStore, __resetAutoWorkerForTest } from '@/stores/autoWorker';

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    title: '写单测',
    description: '给 autoWorker 加测试',
    status: 'todo',
    priority: 'medium',
    assigneeId: 'a1',
    workState: 'idle',
    isTeamTask: false,
    canonicalExecution: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as KanbanTask;
}

/** 让所有已排队的微任务/Promise 链跑完（runOne 是异步 fire-and-forget）。 */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  __resetAutoWorkerForTest();
  gatewayState = 'running';
  agents = [{ id: 'a1', name: '甲', mainSessionKey: 'sess-a1' }];
  tasks = [];
  rpcMock.mockReset();
  updateTaskMock.mockClear();
  startExecMock.mockClear();
  fetchTasksMock.mockClear();
  // 重置 worker 状态（同一模块单例）。
  useAutoWorkerStore.setState({
    enabled: true,
    running: true,
    concurrency: 2,
    maxAttempts: 3,
    activeTaskIds: [],
    processed: 0,
    note: '',
  });
});

describe('autoWorker · S8/S9/S10', () => {
  it('S8 自动领取并派活：todo+idle 任务被 startTaskExecution 派发，成功后流转 review/done', async () => {
    rpcMock.mockResolvedValue({ runId: 'run-1' });
    tasks = [makeTask({ id: 't1' })];

    await useAutoWorkerStore.getState()._tick();
    await flush();

    // 真实调了网关 RPC + 记录 execution + 回写终态
    expect(rpcMock).toHaveBeenCalledWith('chat.send', expect.objectContaining({ sessionKey: 'sess-a1' }), expect.any(Number));
    expect(startExecMock).toHaveBeenCalledWith('t1', expect.objectContaining({ sessionKey: 'sess-a1' }));
    const t1 = tasks.find((t) => t.id === 't1')!;
    expect(t1.status).toBe('review');
    expect(t1.workState).toBe('done');
  });

  it('S10 并发不重复：concurrency=2 时同一轮最多占 2 槽，且不会重复领取同一任务', async () => {
    // rpc 永不 resolve → 任务停在在途，用来观测“同时占几个槽”
    rpcMock.mockImplementation(() => new Promise(() => {}));
    tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2' }), makeTask({ id: 't3' })];

    await useAutoWorkerStore.getState()._tick();
    await flush();

    // 只应领取 2 条（并发上限）→ 只对 2 条发起了网关派活，且是不同的两条
    expect(rpcMock).toHaveBeenCalledTimes(2);
    const dispatched = rpcMock.mock.calls.map((c) => (c[1] as { sessionKey: string }).sessionKey);
    // 三条任务同一 agent，这里核对“占了 2 个在途槽、且都是不同任务”
    expect(useAutoWorkerStore.getState().activeTaskIds.length).toBe(2);
    expect(new Set(useAutoWorkerStore.getState().activeTaskIds).size).toBe(2);
    expect(dispatched.length).toBe(2);
  });

  it('S9 自动重试：派活失败且未达上限 → 任务被复位为 todo/idle 重排队', async () => {
    rpcMock.mockRejectedValue(new Error('gateway boom'));
    tasks = [makeTask({ id: 't1' })];

    await useAutoWorkerStore.getState()._tick();
    await flush();

    const t1 = tasks.find((t) => t.id === 't1')!;
    // 失败后被 S9 复位为可重跑
    expect(t1.status).toBe('todo');
    expect(t1.workState).toBe('idle');
    // 曾写过 failed（派活失败）也写过复位（idle）
    const states = updateTaskMock.mock.calls.map((c) => (c[1] as Partial<KanbanTask>).workState);
    expect(states).toContain('failed');
    expect(states).toContain('idle');
  });

  it('S9 达到上限终止：第 maxAttempts 次失败后不再复位（保持 failed）', async () => {
    useAutoWorkerStore.setState({ maxAttempts: 2, concurrency: 1 });
    rpcMock.mockRejectedValue(new Error('always fail'));
    tasks = [makeTask({ id: 't1' })];

    // 第 1 次失败 → 重排队
    await useAutoWorkerStore.getState()._tick();
    await flush();
    expect(tasks[0].workState).toBe('idle');

    // 第 2 次失败 → 达上限，终止（不再复位为 idle）
    await useAutoWorkerStore.getState()._tick();
    await flush();
    expect(tasks[0].workState).toBe('failed');
    // 达上限后不再被复位为可重跑（workState 保持 failed，未回到 idle）
    expect(tasks[0].workState).not.toBe('idle');
  });

  it('结构性失败：任务无可用 sessionKey → failed，且不进入自动重试', async () => {
    agents = []; // a1 不再有 mainSessionKey
    tasks = [makeTask({ id: 't1', assigneeId: 'a1' })];

    await useAutoWorkerStore.getState()._tick();
    await flush();

    const t1 = tasks.find((t) => t.id === 't1')!;
    expect(t1.workState).toBe('failed');
    // 没被复位为 idle（不重试），也没调网关
    expect(t1.workState).not.toBe('idle');
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
