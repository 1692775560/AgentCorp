/**
 * tests/unit/eventSink.throttle.test.ts
 *
 * createThrottledEventSink（autoWorker 执行事件写回节流器，增量 append 版）语义验证：
 * - 连续 push 不立即落库，800ms 窗口内合并成一批，逐条走 appendTaskExecutionEvent 原子 append；
 * - 不再全量 PUT executionEvents（运行期会话消息走同一 append 端点，全量覆盖会抹掉它们）；
 * - flush() 立即落尾部事件（不丢尾）；
 * - flush() 幂等：无待写事件时不再写；
 * - append 失败静默吞掉，不影响后续批次。
 *
 * 隔离：mock '@/stores/approvals'，fake timers 控制时间。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaskExecutionEventInput } from '@/types/task';
import type { A2aTraceRecord } from '@/types/evaluation';

const appendEventMock = vi.fn(async () => ({}));
const updateTaskMock = vi.fn(async () => ({}));

vi.mock('@/stores/approvals', () => ({
  useApprovalsStore: {
    getState: () => ({
      appendTaskExecutionEvent: appendEventMock,
      updateTask: updateTaskMock,
    }),
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

/** 已 append 的事件列表（按调用顺序）。 */
function appendedEvents(): TaskExecutionEventInput[] {
  return appendEventMock.mock.calls.map((c) => c[1] as TaskExecutionEventInput);
}

beforeEach(() => {
  vi.useFakeTimers();
  appendEventMock.mockClear();
  updateTaskMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createThrottledEventSink · 增量 append 节流', () => {
  it('连续 push 不立即落库，800ms 窗口内合并成一批逐条原子 append（不全量 PUT）', async () => {
    const sink = createThrottledEventSink('task-1');

    sink.push(trace(1));
    sink.push(trace(2));
    sink.push(trace(3));
    expect(appendEventMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(800);
    // 三条新增事件逐条走原子 append 端点，形状与 traceToEvent 一致
    expect(appendEventMock).toHaveBeenCalledTimes(3);
    const events = appendedEvents();
    expect(events.map((e) => e.content)).toEqual(['【第1轮】第1轮', '【第2轮】第2轮', '【第3轮】第3轮']);
    expect(events.every((e) => e.type === 'a2a:leader → member' && e.status === 'done')).toBe(true);
    // 关键回归：不再全量 PUT executionEvents
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('相隔超过窗口的 push 各自落库一批', async () => {
    const sink = createThrottledEventSink('task-1');

    sink.push(trace(1));
    await vi.advanceTimersByTimeAsync(800);
    sink.push(trace(2));
    await vi.advanceTimersByTimeAsync(800);
    expect(appendEventMock).toHaveBeenCalledTimes(2);
  });

  it('flush() 立即落尾部事件，不丢尾', async () => {
    const sink = createThrottledEventSink('task-1');

    sink.push(trace(1));
    await vi.advanceTimersByTimeAsync(800); // 第一批已落
    sink.push(trace(2)); // 尾部事件还在窗口内
    await sink.flush();
    expect(appendEventMock).toHaveBeenCalledTimes(2);
    // flush 后定时器已清，推进时间不应再触发写入
    await vi.advanceTimersByTimeAsync(2000);
    expect(appendEventMock).toHaveBeenCalledTimes(2);
  });

  it('无待写事件时 flush() 是空操作', async () => {
    const sink = createThrottledEventSink('task-1');
    await sink.flush();
    expect(appendEventMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('单条 append 失败被吞掉，不阻断后续事件与 flush', async () => {
    appendEventMock
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValue({} as never);
    const sink = createThrottledEventSink('task-1');

    sink.push(trace(1));
    sink.push(trace(2));
    await sink.flush();
    expect(appendEventMock).toHaveBeenCalledTimes(2);
    // 第二批照常可写
    sink.push(trace(3));
    await sink.flush();
    expect(appendEventMock).toHaveBeenCalledTimes(3);
  });
});
