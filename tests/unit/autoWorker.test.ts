/**
 * tests/unit/autoWorker.test.ts
 *
 * 自动任务 worker 单测（S8/S9/S10，合并到主干 tasks+execution 之上）：
 * - S8 自动领取：网关连上后，_tick 领取 status='todo' && workState='idle' 的任务并派活。
 * - S10 并发不重复：一次 tick 最多同时占 concurrency 个槽，且不会把同一条任务领两次。
 * - S9 自动重试：派活失败（gateway.rpc 抛错）→ 未达 maxAttempts 时任务被复位为 todo/idle 重排队；
 *   达到 maxAttempts 后不再重试（终止，status 复位 todo + workState 保持 failed，人工重试入口）。
 * - 结构性失败：任务无 assignee/sessionKey → failed，且不进入自动重试（避免死循环）。
 * - 网关回退终态回写：chat.send 拿到 runId 后不再假完成，轮询 chat.history 拿真实产出
 *   回写 review/done；超时则诚实降级 failed + 退回 todo。
 * - 启动恢复：首次 fetchTasks 后清扫 stale working（in-progress + working/starting 且
 *   updatedAt 超 10 分钟）复位为 failed。
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
const appendEventMock = vi.fn(async (id: string) => tasks.find((t) => t.id === id));
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
      appendTaskExecutionEvent: appendEventMock,
    }),
  },
}));
vi.mock('@/lib/task-notify', () => ({ notifyTaskTerminal: vi.fn() }));

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

/** 网关派发成功 + 会话历史里有一条新鲜助手产出（终态回写成功路径）。 */
function mockGatewayRunCompletes(output: string): void {
  rpcMock.mockImplementation(async (method: string) => {
    if (method === 'chat.send') return { runId: 'run-1' };
    if (method === 'chat.history') {
      return {
        messages: [
          { role: 'assistant', content: output, timestamp: Date.now() / 1000 },
        ],
      };
    }
    return {};
  });
}

beforeEach(() => {
  __resetAutoWorkerForTest();
  gatewayState = 'running';
  agents = [{ id: 'a1', name: '甲', mainSessionKey: 'sess-a1' }];
  tasks = [];
  rpcMock.mockReset();
  updateTaskMock.mockClear();
  startExecMock.mockClear();
  appendEventMock.mockClear();
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
  it('S8 自动领取并派活：todo+idle 任务被派发，网关终态回写真实产出后流转 review/done', async () => {
    mockGatewayRunCompletes('网关真实产出');
    tasks = [makeTask({ id: 't1' })];

    await useAutoWorkerStore.getState()._tick();
    await flush();

    // 真实调了网关 RPC + 记录 execution + 轮询历史拿到产出后回写终态
    expect(rpcMock).toHaveBeenCalledWith('chat.send', expect.objectContaining({ sessionKey: 'sess-a1' }), expect.any(Number));
    expect(rpcMock).toHaveBeenCalledWith('chat.history', expect.objectContaining({ sessionKey: 'sess-a1' }), expect.any(Number));
    expect(startExecMock).toHaveBeenCalledWith('t1', expect.objectContaining({ sessionKey: 'sess-a1' }));
    const t1 = tasks.find((t) => t.id === 't1')!;
    expect(t1.status).toBe('review');
    expect(t1.workState).toBe('done');
    expect(t1.workResult).toBe('网关真实产出');
    // 派发后先落「进行中」，不存在没有真实产出的占位 review
    const updates = updateTaskMock.mock.calls.map((c) => c[1] as Partial<KanbanTask>);
    expect(updates.some((u) => u.workState === 'working')).toBe(true);
    expect(updates.every((u) => u.workResult === undefined || u.workResult === '网关真实产出')).toBe(true);
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

  it('S9 达到上限终止：第 maxAttempts 次失败后不再复位（failed + status 回 todo，不自动死循环）', async () => {
    useAutoWorkerStore.setState({ maxAttempts: 2, concurrency: 1 });
    rpcMock.mockRejectedValue(new Error('always fail'));
    tasks = [makeTask({ id: 't1' })];

    // 第 1 次失败 → 重排队
    await useAutoWorkerStore.getState()._tick();
    await flush();
    expect(tasks[0].workState).toBe('idle');

    // 第 2 次失败 → 达上限，终止：workState 保持 failed（worker 只领 idle，不会死循环），
    // status 复位回 todo（不卡在 in-progress 列，看板「点我重试」可人工重排队）
    await useAutoWorkerStore.getState()._tick();
    await flush();
    expect(tasks[0].workState).toBe('failed');
    expect(tasks[0].workState).not.toBe('idle');
    expect(tasks[0].status).toBe('todo');
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

describe('autoWorker · 网关回退终态回写', () => {
  it('派发后保持进行中，不再拿 runId 占位假完成；历史出现真实产出后才进评审', async () => {
    // chat.history 先挂起 → 观察中间态；放行后回写真实产出
    let resolveHistory: ((v: unknown) => void) | null = null;
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'chat.send') return { runId: 'run-1' };
      if (method === 'chat.history') {
        return new Promise((r) => { resolveHistory = r; });
      }
      return {};
    });
    tasks = [makeTask({ id: 't1' })];

    await useAutoWorkerStore.getState()._tick();
    await flush();

    const t1 = tasks.find((t) => t.id === 't1')!;
    // 仍在等待终态回写：进行中（working/starting 均为非终态），未进评审、无占位 workResult
    expect(t1.status).toBe('in-progress');
    expect(['working', 'starting']).toContain(t1.workState);
    expect(t1.workResult ?? '').not.toContain('已派发');

    // 历史出现本轮真实产出 → 回写 review/done
    resolveHistory?.({
      messages: [{ role: 'assistant', content: '网关真实产出', timestamp: Date.now() / 1000 }],
    });
    await flush();

    const done = tasks.find((t) => t.id === 't1')!;
    expect(done.status).toBe('review');
    expect(done.workState).toBe('done');
    expect(done.workResult).toBe('网关真实产出');
  });

  it('超时降级：轮询始终无产出 → failed + 退回 todo + workError 说明（绝不假完成）', async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'chat.send') return { runId: 'run-1' };
      if (method === 'chat.history') return { messages: [] };
      return {};
    });
    tasks = [makeTask({ id: 't1' })];

    vi.useFakeTimers();
    await useAutoWorkerStore.getState()._tick();
    // 先让 runOne 的微任务链推进到首个轮询 sleep（fake timers 不影响微任务）
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    // 推进超过 10 分钟轮询超时
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    vi.useRealTimers();
    await flush();

    const t1 = tasks.find((t) => t.id === 't1')!;
    expect(t1.workState).toBe('failed');
    expect(t1.status).toBe('todo');
    expect(t1.workError).toContain('网关执行结果回写超时');
    // 不曾写过 review/done 假完成
    const updates = updateTaskMock.mock.calls.map((c) => c[1] as Partial<KanbanTask>);
    expect(updates.some((u) => u.status === 'review')).toBe(false);
  });

  it('历史里只有派发前的旧助手回复 → 不拿旧回复冒充，继续轮询直到新产出', async () => {
    const staleTs = (Date.now() - 60_000) / 1000;
    let historyCalls = 0;
    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'chat.send') return { runId: 'run-1' };
      if (method === 'chat.history') {
        historyCalls += 1;
        if (historyCalls === 1) {
          return { messages: [{ role: 'assistant', content: '上一轮旧回复', timestamp: staleTs }] };
        }
        return { messages: [{ role: 'assistant', content: '本轮真实产出', timestamp: Date.now() / 1000 }] };
      }
      return {};
    });
    tasks = [makeTask({ id: 't1' })];

    vi.useFakeTimers();
    await useAutoWorkerStore.getState()._tick();
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    // 推进一个轮询周期，让第二次历史查询发生
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    await flush();

    const t1 = tasks.find((t) => t.id === 't1')!;
    expect(t1.status).toBe('review');
    expect(t1.workResult).toBe('本轮真实产出');
    expect(historyCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('autoWorker · 启动恢复（stale working 清扫）', () => {
  it('首次 tick 清扫：in-progress + working 且 updatedAt 超 10 分钟 → failed + 中断说明', async () => {
    mockGatewayRunCompletes('无关');
    const stale = makeTask({
      id: 'stale-1',
      status: 'in-progress',
      workState: 'working',
      updatedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    });
    const fresh = makeTask({
      id: 'fresh-1',
      status: 'in-progress',
      workState: 'working',
      updatedAt: new Date().toISOString(),
    });
    tasks = [stale, fresh];

    await useAutoWorkerStore.getState()._tick();
    await flush();

    const staleAfter = tasks.find((t) => t.id === 'stale-1')!;
    expect(staleAfter.workState).toBe('failed');
    expect(staleAfter.workError).toContain('执行中断');
    // 新鲜的 working 任务不动
    expect(tasks.find((t) => t.id === 'fresh-1')!.workState).toBe('working');
  });

  it('starting 状态同样清扫；每次会话只清扫一次（第二次 tick 不再重复写）', async () => {
    rpcMock.mockResolvedValue({});
    tasks = [
      makeTask({
        id: 'stale-2',
        status: 'in-progress',
        workState: 'starting',
        updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      }),
    ];

    await useAutoWorkerStore.getState()._tick();
    await flush();
    expect(tasks[0].workState).toBe('failed');

    updateTaskMock.mockClear();
    await useAutoWorkerStore.getState()._tick();
    await flush();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });
});
