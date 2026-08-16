/**
 * tests/unit/eventSink.throttle.test.ts
 *
 * createThrottledEventSink（autoWorker 执行事件写回节流器）语义验证：
 * - 连续 push 不立即落库，800ms 窗口内合并成一次 PUT；
 * - flush() 立即落尾部事件（不丢尾）；
 * - flush() 幂等：无脏数据时不再写。
 *
 * 隔离：mock '@/stores/approvals'，fake timers 控制时间。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaskExecutionEvent } from '@/types/task';
import type { A2aTraceRecord } from '@/types/evaluation';

const updateTaskMock = vi.fn(async () => ({}));

vi.mock('@/stores/approvals', () => ({
  useApprovalsStore: {
    getState: () => ({ updateTask: updateTaskMock }),
  },
}));

import { createThrottledEventSink } from '@/stores/autoWorker';

function trace(round: number): A2aTraceRecord {
  return {
    task_id: 'task-1',
    delegator: 'leader',
    delegatee: 'member',
    round,
    summary: `第${round}轮`,
    state: 'completed',
    sent_at: new Date().toISOString(),
  } as A2aTraceRecord;
}

beforeEach(() => {
  vi.useFakeTimers();
  updateTaskMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createThrottledEventSink · 事件写回节流', () => {
  it('连续 push 不立即落库，800ms 窗口内合并成一次 PUT', async () => {
    const events: TaskExecutionEvent[] = [];
    const sink = createThrottledEventSink('task-1', events);

    sink.push(trace(1));
    sink.push(trace(2));
    sink.push(trace(3));
    expect(updateTaskMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(800);
    expect(updateTaskMock).toHaveBeenCalledTimes(1);
    const [, updates] = updateTaskMock.mock.calls[0] as [string, { executionEvents: TaskExecutionEvent[] }];
    expect(updates.executionEvents).toHaveLength(3);
  });

  it('相隔超过窗口的 push 各自落库一次', async () => {
    const events: TaskExecutionEvent[] = [];
    const sink = createThrottledEventSink('task-1', events);

    sink.push(trace(1));
    await vi.advanceTimersByTimeAsync(800);
    sink.push(trace(2));
    await vi.advanceTimersByTimeAsync(800);
    expect(updateTaskMock).toHaveBeenCalledTimes(2);
  });

  it('flush() 立即落尾部事件，不丢尾', async () => {
    const events: TaskExecutionEvent[] = [];
    const sink = createThrottledEventSink('task-1', events);

    sink.push(trace(1));
    await vi.advanceTimersByTimeAsync(800); // 第一次已落
    sink.push(trace(2)); // 尾部事件还在窗口内
    await sink.flush();
    expect(updateTaskMock).toHaveBeenCalledTimes(2);
    const [, updates] = updateTaskMock.mock.calls[1] as [string, { executionEvents: TaskExecutionEvent[] }];
    expect(updates.executionEvents).toHaveLength(2);
    // flush 后定时器已清，推进时间不应再触发写入
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateTaskMock).toHaveBeenCalledTimes(2);
  });

  it('无脏数据时 flush() 是空操作', async () => {
    const events: TaskExecutionEvent[] = [];
    const sink = createThrottledEventSink('task-1', events);
    await sink.flush();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });
});
