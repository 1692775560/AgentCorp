/**
 * tests/unit/task-reconcile.test.ts
 *
 * approvals.fetchTasks 轮询 reconcile（reconcileTasks）单测：
 * - 内容未变的任务保留旧对象引用（TaskCard memo / useMemo 依赖引用稳定的前提）。
 * - 整列表无变化时保留旧数组引用（zustand Object.is 让订阅组件完全跳过渲染）。
 * - 内容变化 / 新增 / 删除 / 重排时正确返回新数组，且未变任务仍保留引用。
 *
 * 背景：autoWorker 每 3s 全量拉 /api/tasks，旧实现每次 set 全新对象，
 * 导致看板/会话列表/任务会话每轮全部重渲染。
 * 运行：pnpm vitest run tests/unit/task-reconcile.test.ts
 */
import { describe, it, expect } from 'vitest';
import { reconcileTasks } from '@/lib/task-reconcile';
import type { KanbanTask } from '@/types/task';

function makeTask(id: string, overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id,
    title: `任务 ${id}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    workState: 'idle',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    executionEvents: [],
    ...overrides,
  } as KanbanTask;
}

describe('reconcileTasks', () => {
  it('整列表内容相同时保留旧数组引用（订阅组件零重渲染）', () => {
    const prev = [makeTask('a'), makeTask('b', { status: 'in-progress' })];
    // 模拟 JSON 重新解析：结构相同但引用全新
    const next = prev.map((t) => JSON.parse(JSON.stringify(t)) as KanbanTask);

    const merged = reconcileTasks(prev, next);

    expect(merged).toBe(prev);
    expect(merged[0]).toBe(prev[0]);
    expect(merged[1]).toBe(prev[1]);
  });

  it('单条任务变化时只换该任务引用，其余保留', () => {
    const prev = [makeTask('a'), makeTask('b'), makeTask('c')];
    const next = prev.map((t) => JSON.parse(JSON.stringify(t)) as KanbanTask);
    next[1] = { ...next[1], status: 'review', workState: 'done' };

    const merged = reconcileTasks(prev, next);

    expect(merged).not.toBe(prev);
    expect(merged[0]).toBe(prev[0]);
    expect(merged[1]).not.toBe(prev[1]);
    expect(merged[1].status).toBe('review');
    expect(merged[2]).toBe(prev[2]);
  });

  it('嵌套字段（executionEvents 追加事件）变化能被识别', () => {
    const prev = [makeTask('a', { executionEvents: [] })];
    const next = [
      {
        ...JSON.parse(JSON.stringify(prev[0])),
        executionEvents: [{ type: 'a2a:x → y', createdAt: '2026-08-01T00:01:00.000Z' }],
      } as KanbanTask,
    ];

    const merged = reconcileTasks(prev, next);

    expect(merged[0]).not.toBe(prev[0]);
    expect(merged[0].executionEvents).toHaveLength(1);
  });

  it('重排（同集合不同顺序）返回新数组但保留各任务引用', () => {
    const prev = [makeTask('a'), makeTask('b')];
    const next = [
      JSON.parse(JSON.stringify(prev[1])) as KanbanTask,
      JSON.parse(JSON.stringify(prev[0])) as KanbanTask,
    ];

    const merged = reconcileTasks(prev, next);

    expect(merged).not.toBe(prev);
    expect(merged[0]).toBe(prev[1]);
    expect(merged[1]).toBe(prev[0]);
  });

  it('新增 / 删除任务返回新数组', () => {
    const prev = [makeTask('a')];
    const added = reconcileTasks(prev, [...prev.map((t) => JSON.parse(JSON.stringify(t))), makeTask('b')]);
    expect(added).not.toBe(prev);
    expect(added).toHaveLength(2);
    expect(added[0]).toBe(prev[0]);

    const removed = reconcileTasks(added, []);
    expect(removed).toEqual([]);
  });

  it('prev 为空（首次加载）直接采用 next', () => {
    const next = [makeTask('a')];
    expect(reconcileTasks([], next)).toBe(next);
  });
});
