/**
 * tests/unit/approvals-store.test.ts
 *
 * approvals store（看板/审批数据真相层）单测（mock hostApiFetch 网络层）：
 * - applyTaskSnapshotResponse 快照合并语义：全量 tasks 优先；单 task 按 id 更新/追加；
 *   空响应保守返回原列表；
 * - createTask/updateTask/startTaskExecution：响应缺 task → 抛错（不落半成品状态）；
 * - deleteTask：服务端无全量快照时回退本地过滤；
 * - appendTaskExecutionEvent：chat: 前缀事件在非当前会话时未读 +1（a2a: 不计）；
 * - approveItem/rejectItem：后端确认后登记治理审计（recordHostApproval）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KanbanTask } from '@/types/task';

const hostApiFetchMock = vi.fn();
vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

const recordHostApprovalMock = vi.fn();
vi.mock('@/engine/governance/approvalGate', () => ({
  recordHostApproval: (...args: unknown[]) => recordHostApprovalMock(...args),
}));

const updateSessionUnreadCountMock = vi.fn();
vi.mock('@/stores/chat', () => ({
  useChatStore: {
    getState: () => ({
      currentSessionKey: 'chat:elsewhere',
      updateSessionUnreadCount: updateSessionUnreadCountMock,
    }),
  },
}));

import { useApprovalsStore } from '@/stores/approvals';

const store = () => useApprovalsStore.getState();

function makeTask(id: string, title = `任务${id}`): KanbanTask {
  return {
    id,
    title,
    description: '',
    status: 'todo',
    priority: 'medium',
    workState: 'idle',
    isTeamTask: false,
  } as KanbanTask;
}

describe('approvals store · 任务快照合并', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
    recordHostApprovalMock.mockClear();
    updateSessionUnreadCountMock.mockClear();
    useApprovalsStore.setState({ approvals: [], tasks: [], loading: false, error: null });
  });

  it('createTask：单 task 响应追加进列表', async () => {
    useApprovalsStore.setState({ tasks: [makeTask('t1')] });
    hostApiFetchMock.mockResolvedValue({ task: makeTask('t2') });
    const created = await store().createTask({ title: '任务t2' } as never);
    expect(created.id).toBe('t2');
    expect(store().tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('updateTask：同 id 更新替换（不追加副本）', async () => {
    useApprovalsStore.setState({ tasks: [makeTask('t1'), makeTask('t2')] });
    hostApiFetchMock.mockResolvedValue({ task: makeTask('t2', '改后') });
    await store().updateTask('t2', { title: '改后' });
    expect(store().tasks).toHaveLength(2);
    expect(store().tasks[1].title).toBe('改后');
  });

  it('响应为全量 tasks 快照时直接替换整个列表', async () => {
    useApprovalsStore.setState({ tasks: [makeTask('t1')] });
    hostApiFetchMock.mockResolvedValue({ task: makeTask('t1'), tasks: [makeTask('t9')] });
    await store().updateTask('t1', { title: 'x' });
    expect(store().tasks.map((t) => t.id)).toEqual(['t9']);
  });

  it('createTask/updateTask/startTaskExecution 响应缺 task → 抛错', async () => {
    hostApiFetchMock.mockResolvedValue({});
    await expect(store().createTask({ title: 'x' } as never)).rejects.toThrow('Missing task');
    await expect(store().updateTask('t1', {})).rejects.toThrow('Missing task');
    await expect(store().startTaskExecution('t1', {} as never)).rejects.toThrow('Missing task');
  });

  it('deleteTask：服务端无快照 → 本地过滤回退', async () => {
    useApprovalsStore.setState({ tasks: [makeTask('t1'), makeTask('t2')] });
    hostApiFetchMock.mockResolvedValue({});
    await store().deleteTask('t1');
    expect(store().tasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('deleteTask：服务端有全量快照 → 以快照为准', async () => {
    useApprovalsStore.setState({ tasks: [makeTask('t1'), makeTask('t2')] });
    hostApiFetchMock.mockResolvedValue({ tasks: [] });
    await store().deleteTask('t1');
    expect(store().tasks).toEqual([]);
  });

  it('appendTaskExecutionEvent：chat: 事件且非当前会话 → 未读 +1', async () => {
    hostApiFetchMock.mockResolvedValue({ task: makeTask('t1') });
    await store().appendTaskExecutionEvent('t1', { type: 'chat:user', content: 'hi' } as never);
    await vi.waitFor(() => {
      if (!updateSessionUnreadCountMock.mock.calls.length) throw new Error('not called');
    });
    expect(updateSessionUnreadCountMock).toHaveBeenCalledWith('team-task:t1', 1);
  });

  it('appendTaskExecutionEvent：a2a: trace 噪音不计未读', async () => {
    hostApiFetchMock.mockResolvedValue({ task: makeTask('t1') });
    await store().appendTaskExecutionEvent('t1', { type: 'a2a:delegate' } as never);
    await new Promise((r) => setTimeout(r, 20));
    expect(updateSessionUnreadCountMock).not.toHaveBeenCalled();
  });

  it('approveItem：后端确认后登记治理审计并刷新列表', async () => {
    useApprovalsStore.setState({
      approvals: [{ id: 'ap1', sessionKey: 'sess-1', command: 'exec', agentId: 'a1' }],
    });
    hostApiFetchMock
      .mockResolvedValueOnce({}) // approve
      .mockResolvedValueOnce({ approvals: [] }); // fetchApprovals
    await store().approveItem('ap1', '放行');
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/approvals/approve', expect.objectContaining({ method: 'POST' }));
    expect(recordHostApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'ap1', decision: 'approve', reason: '放行' }),
    );
  });

  it('rejectItem：登记 reject 决策', async () => {
    useApprovalsStore.setState({ approvals: [{ id: 'ap2' }] });
    hostApiFetchMock
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ approvals: [] });
    await store().rejectItem('ap2', '风险过高');
    expect(recordHostApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'ap2', decision: 'reject', reason: '风险过高' }),
    );
  });
});
