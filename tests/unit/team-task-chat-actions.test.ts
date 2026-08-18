/**
 * tests/unit/team-task-chat-actions.test.ts
 *
 * 会话派活动作（team-task-chat.ts 依赖注入函数）单测，覆盖房间/任务会话链路修复：
 * - B1 确认开工顺序：先 createTask 后落 confirmed；createTask 失败不落处置；
 *   处置落库失败容忍（任务已建继续开工）。
 * - B2 知会消息 best-effort：知会 append 抛错不阻断 runWorkOrder 触发
 *   （确认开工 / @成员直派 / 任务会话立新任务 三处）。
 * - B3 生效指令随任务走：直派/确认开工的生效指令写进 task.description；
 *   runWorkOrder 受理失败（false）提示「任务已在执行队列中」而非静默。
 * - B4 打回重做看受理结果：false 时状态改回 review + 报错提示。
 * - B7 任务会话 rework：受理成功才提示「开始执行」，false 提示被占用。
 * - B8 历史快照：append 前取的快照与之后的事件变动解耦，不再 slice(0,-1)。
 */
import { describe, expect, it, vi } from 'vitest';
import type { KanbanTask } from '@/types/task';
import {
  acceptTaskRework,
  buildConfirmedDraftInstruction,
  buildDirectAssignInstruction,
  confirmTaskDraftAndRun,
  createTaskFromChatIntake,
  parseTaskDraftResolution,
  rejectDeliveryAndRework,
  runDirectAssign,
  snapshotRoomHistory,
  type NewTaskFromChatDeps,
  type ReworkWorkOrderDeps,
  type RoomWorkOrderDeps,
} from '@/lib/team-task-chat';

const TEAM = { id: 'team-1', name: '马斯克团队' };
const CARD = { id: 'd1-1', title: '做调研', requirement: '调研竞品并出报告' };

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: 't-new',
    title: '做调研',
    description: '',
    status: 'todo',
    priority: 'medium',
    workState: 'idle',
    isTeamTask: true,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as KanbanTask;
}

function makeToast() {
  return { info: vi.fn(), error: vi.fn() };
}

/** triggerWorkOrder 是 fire-and-forget，等微任务轮空再断言 .then 分支。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeRoomDeps(overrides: Partial<RoomWorkOrderDeps> = {}) {
  const calls: string[] = [];
  const deps: RoomWorkOrderDeps = {
    createTask: vi.fn(async (input) => {
      calls.push('createTask');
      return makeTask({ title: input.title, description: input.description });
    }),
    appendRoomEvent: vi.fn(async () => {
      calls.push('appendRoomEvent');
    }),
    ensureTeamTaskSession: vi.fn(),
    runWorkOrder: vi.fn(async () => {
      calls.push('runWorkOrder');
      return true;
    }),
    toast: makeToast(),
    ...overrides,
  };
  return { deps, calls };
}

describe('B1 确认开工顺序（confirmTaskDraftAndRun）', () => {
  it('createTask 失败 → 不落 confirmed 处置、不触发执行，错误上抛', async () => {
    const { deps } = makeRoomDeps({
      createTask: vi.fn(async () => {
        throw new Error('网络超时');
      }),
    });
    await expect(confirmTaskDraftAndRun(CARD, TEAM, 'leader', deps)).rejects.toThrow('网络超时');
    expect(deps.appendRoomEvent).not.toHaveBeenCalled();
    expect(deps.runWorkOrder).not.toHaveBeenCalled();
    expect(deps.ensureTeamTaskSession).not.toHaveBeenCalled();
  });

  it('createTask 成功后才落 confirmed 处置（顺序：createTask → 处置 → 执行）', async () => {
    const { deps, calls } = makeRoomDeps();
    await confirmTaskDraftAndRun(CARD, TEAM, 'leader', deps);
    await flush();

    expect(calls).toEqual(['createTask', 'appendRoomEvent', 'appendRoomEvent', 'runWorkOrder']);
    // 第一条房间事件是 confirmed 处置
    const first = (deps.appendRoomEvent as ReturnType<typeof vi.fn>).mock.calls[0][1] as { content: string };
    expect(parseTaskDraftResolution(first.content)).toEqual({ id: CARD.id, action: 'confirmed' });
    expect(deps.runWorkOrder).toHaveBeenCalledWith('t-new', buildConfirmedDraftInstruction(CARD.requirement));
    expect(deps.toast.info).toHaveBeenCalledWith('已立项，团队开始执行，过程可在任务会话中查看');
  });

  it('confirmed 处置落库失败 → 容忍：提示但继续开工', async () => {
    const appendRoomEvent = vi.fn()
      .mockRejectedValueOnce(new Error('写库失败')) // confirmed 处置
      .mockResolvedValue(undefined); // 知会
    const { deps } = makeRoomDeps({ appendRoomEvent });
    await confirmTaskDraftAndRun(CARD, TEAM, 'leader', deps);
    await flush();

    expect(deps.runWorkOrder).toHaveBeenCalled();
    expect(deps.ensureTeamTaskSession).toHaveBeenCalled();
    expect(deps.toast.info).toHaveBeenCalledWith('任务已立项，确认记录同步失败，卡片状态稍后刷新');
  });
});

describe('B2 知会消息 best-effort（不阻断执行触发）', () => {
  it('确认开工：知会 append 抛错 → runWorkOrder 照常触发', async () => {
    const appendRoomEvent = vi.fn()
      .mockResolvedValueOnce(undefined) // confirmed 处置
      .mockRejectedValueOnce(new Error('知会写库失败'));
    const { deps } = makeRoomDeps({ appendRoomEvent });
    await confirmTaskDraftAndRun(CARD, TEAM, 'leader', deps);
    await flush();
    expect(deps.runWorkOrder).toHaveBeenCalledWith('t-new', expect.any(String));
    expect(deps.toast.error).not.toHaveBeenCalled();
  });

  it('@成员直派：知会 append 抛错 → runWorkOrder 照常触发', async () => {
    const { deps } = makeRoomDeps({
      appendRoomEvent: vi.fn(async () => {
        throw new Error('知会写库失败');
      }),
    });
    await runDirectAssign(TEAM, 'leader', { targetId: 'm1', targetName: '小明', instruction: '写个脚本' }, deps);
    await flush();
    expect(deps.runWorkOrder).toHaveBeenCalled();
    expect(deps.toast.error).not.toHaveBeenCalled();
  });

  it('任务会话立新任务：知会 appendTaskEvent 抛错 → runWorkOrder 照常触发', async () => {
    const deps: NewTaskFromChatDeps = {
      createTask: vi.fn(async (input) => makeTask({ title: input.title })),
      ensureTeamTaskSession: vi.fn(),
      appendTaskEvent: vi.fn(async () => {
        throw new Error('事件写库失败');
      }),
      runWorkOrder: vi.fn(async () => true),
      toast: makeToast(),
    };
    await createTaskFromChatIntake(
      { taskId: 't-src', teamId: TEAM.id, teamName: TEAM.name, leaderId: 'leader' },
      { title: '新活', requirement: '做个计算器' },
      '做个计算器',
      deps,
    );
    await flush();
    expect(deps.runWorkOrder).toHaveBeenCalledWith('t-new', '做个计算器');
    expect(deps.toast.info).toHaveBeenCalledWith('已立项「新活」并开始执行');
    expect(deps.toast.error).not.toHaveBeenCalled();
  });
});

describe('B3 生效指令随任务走 + 受理结果提示', () => {
  it('直派：description 是带【指定执行】前缀的生效指令，assignee 指向目标成员', async () => {
    const { deps } = makeRoomDeps();
    await runDirectAssign(TEAM, 'leader', { targetId: 'm1', targetName: '小明', instruction: '写个脚本' }, deps);
    const input = (deps.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(input.description).toBe(buildDirectAssignInstruction('小明', '写个脚本'));
    expect(input.description).toContain('【指定执行：@小明】');
    expect(input.assigneeId).toBe('m1');
    expect(input.assigneeRole).toBe('小明');
    expect(deps.runWorkOrder).toHaveBeenCalledWith('t-new', input.description);
  });

  it('确认开工：description 是「草稿已确认」前缀 + 完整需求', async () => {
    const { deps } = makeRoomDeps();
    await confirmTaskDraftAndRun(CARD, TEAM, 'leader', deps);
    const input = (deps.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(input.description).toBe(`草稿已确认，按立项需求执行。\n${CARD.requirement}`);
  });

  it('runWorkOrder 返回 false（任务被占用）→ toast「任务已在执行队列中」而非静默', async () => {
    const { deps } = makeRoomDeps({ runWorkOrder: vi.fn(async () => false) });
    await confirmTaskDraftAndRun(CARD, TEAM, 'leader', deps);
    await flush();
    expect(deps.toast.info).toHaveBeenCalledWith('任务已在执行队列中');
  });

  it('runWorkOrder 抛错 → toast 派活执行失败', async () => {
    const { deps } = makeRoomDeps({
      runWorkOrder: vi.fn(async () => {
        throw new Error('编排爆炸');
      }),
    });
    await runDirectAssign(TEAM, 'leader', { targetId: 'm1', targetName: '小明', instruction: '写个脚本' }, deps);
    await flush();
    expect(deps.toast.error).toHaveBeenCalledWith('派活执行失败：编排爆炸');
  });
});

describe('B4 打回重做看受理结果（rejectDeliveryAndRework）', () => {
  function makeReworkDeps(accepted: boolean) {
    const deps: ReworkWorkOrderDeps = {
      updateTask: vi.fn(async () => ({})),
      runWorkOrder: vi.fn(async () => accepted),
      toast: makeToast(),
    };
    return deps;
  }

  it('受理成功 → 回 in-progress 后重跑，返回 true', async () => {
    const deps = makeReworkDeps(true);
    const ok = await rejectDeliveryAndRework({ id: 't1' }, '字体太小', deps);
    expect(ok).toBe(true);
    expect(deps.updateTask).toHaveBeenCalledTimes(1);
    expect(deps.updateTask).toHaveBeenCalledWith('t1', { status: 'in-progress' });
    expect(deps.runWorkOrder).toHaveBeenCalledWith('t1', '打回重做：字体太小');
  });

  it('受理失败（任务被占用）→ 状态改回 review + 报错提示，返回 false', async () => {
    const deps = makeReworkDeps(false);
    const ok = await rejectDeliveryAndRework({ id: 't1' }, '字体太小', deps);
    expect(ok).toBe(false);
    expect(deps.updateTask).toHaveBeenNthCalledWith(1, 't1', { status: 'in-progress' });
    expect(deps.updateTask).toHaveBeenNthCalledWith(2, 't1', { status: 'review' });
    expect(deps.toast.error).toHaveBeenCalledWith('任务正被占用，稍后再试');
  });
});

describe('B7 任务会话 rework 受理结果（acceptTaskRework）', () => {
  it('受理成功才提示「开始执行」', async () => {
    const toast = makeToast();
    await acceptTaskRework('t1', '再加一页', { runWorkOrder: vi.fn(async () => true), toast });
    expect(toast.info).toHaveBeenCalledWith('收到，leader 开始安排成员执行，过程会实时出现在这里');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('未受理（false）→ 提示任务被占用，不报喜', async () => {
    const toast = makeToast();
    await acceptTaskRework('t1', '再加一页', { runWorkOrder: vi.fn(async () => false), toast });
    expect(toast.error).toHaveBeenCalledWith('任务正被占用，稍后再试');
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('执行抛错 → toast 派活执行失败（不上抛）', async () => {
    const toast = makeToast();
    await acceptTaskRework('t1', 'x', {
      runWorkOrder: vi.fn(async () => {
        throw new Error('LLM 超时');
      }),
      toast,
    });
    expect(toast.error).toHaveBeenCalledWith('派活执行失败：LLM 超时');
  });
});

describe('B8 房间历史快照（snapshotRoomHistory）', () => {
  it('快照是拷贝：append 后事件数组变动不影响已取的历史', () => {
    const events = [
      { from: 'user', to: 'leader', content: '帮我做个计算器', createdAt: '1' },
      { from: 'leader', to: 'user', content: '好的', createdAt: '2' },
    ];
    const snapshot = snapshotRoomHistory(events);
    // 模拟 append 用户消息 + 并发广播插入新事件
    events.push({ from: 'user', to: 'leader', content: '开工吧', createdAt: '3' });
    events.push({ from: 'leader', to: 'user', content: '【广播】执行进展', createdAt: '4' });

    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((b) => b.text)).toEqual(['帮我做个计算器', '好的']);
    expect(snapshot.some((b) => b.text.includes('开工吧'))).toBe(false);
    expect(snapshot.some((b) => b.text.includes('【广播】'))).toBe(false);
  });
});
