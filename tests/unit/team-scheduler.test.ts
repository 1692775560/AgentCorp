/**
 * tests/unit/team-scheduler.test.ts
 *
 * 调度触发逻辑：
 * - dueSchedules 纯函数：enabled 过滤、基准 lastFiredAt ?? createdAt、
 *   单调推进不重复触发、进程睡眠错过多次只在结果里出现一次；
 * - runDueTeamSchedules：到期 schedule 创建团队任务（teamId/teamName/title/
 *   description 透传）并把 lastFiredAt 推进到 now（补发一次策略），
 *   单条失败不影响其它 schedule。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TeamSchedule } from '../../src/types/schedule';

const createTaskMock = vi.fn();
const readTeamsConfigMock = vi.fn();
const listSchedulesMock = vi.fn();
const markScheduleFiredMock = vi.fn();

vi.mock('../../electron/utils/task-config', () => ({
  createTask: (...args: unknown[]) => createTaskMock(...args),
}));

vi.mock('../../electron/utils/team-config', () => ({
  readTeamsConfig: () => readTeamsConfigMock(),
}));

vi.mock('../../electron/utils/schedule-config', () => ({
  listSchedules: () => listSchedulesMock(),
  markScheduleFired: (...args: unknown[]) => markScheduleFiredMock(...args),
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { dueSchedules, runDueTeamSchedules } = await import('../../electron/utils/team-scheduler');

function makeSchedule(overrides: Partial<TeamSchedule>): TeamSchedule {
  return {
    id: 'schedule-1',
    teamId: 'team-1',
    title: '每日晨报',
    instruction: '汇总昨天进展',
    cron: '0 9 * * *',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  createTaskMock.mockReset().mockResolvedValue({ id: 'task-new' });
  readTeamsConfigMock.mockReset().mockResolvedValue([{ id: 'team-1', name: '晨报团队' }]);
  listSchedulesMock.mockReset().mockResolvedValue([]);
  markScheduleFiredMock.mockReset().mockResolvedValue(undefined);
});

describe('dueSchedules 纯函数', () => {
  it('过滤 disabled 与未到期的 schedule', () => {
    const now = new Date('2026-01-02T10:00:00');
    const schedules = [
      makeSchedule({ id: 'a', enabled: false }), // disabled
      makeSchedule({ id: 'b', cron: '0 9 * * *', createdAt: '2026-01-02T08:00:00' }), // 今天 9:00 已过 → 到期
      makeSchedule({ id: 'c', cron: '0 20 * * *', createdAt: '2026-01-02T08:00:00' }), // 20:00 未到
    ];
    const due = dueSchedules(schedules, now);
    expect(due.map((item) => item.schedule.id)).toEqual(['b']);
  });

  it('基准为 lastFiredAt ?? createdAt：lastFiredAt 推进后同一触发点不再命中', () => {
    const now = new Date('2026-01-02T10:00:00');
    const never = makeSchedule({ id: 'never', createdAt: '2026-01-01T08:00:00' });
    const fired = makeSchedule({
      id: 'fired',
      createdAt: '2026-01-01T08:00:00',
      lastFiredAt: '2026-01-02T09:05:00',
    });
    const due = dueSchedules([never, fired], now);
    // never：1 月 1 日 9:00 起多次到期 → 只出现一次（补发策略）
    // fired：上次触发在 1 月 2 日 9:05，下一次是 1 月 3 日 9:00 → 不命中
    expect(due.map((item) => item.schedule.id)).toEqual(['never']);
    expect(due[0].fireAt.getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it('错过多次只补一次：返回的 fireAt 是基准后的第一个触发点，不逐次罗列', () => {
    const schedule = makeSchedule({
      id: 'slept',
      cron: '*/30 * * * *',
      createdAt: '2026-01-01T00:00:00',
    });
    // 进程睡了一整天
    const due = dueSchedules([schedule], new Date('2026-01-02T00:00:00'));
    expect(due).toHaveLength(1);
  });

  it('非法 cron / 非法基准时间不抛出、不命中', () => {
    const now = new Date('2026-01-02T10:00:00');
    const schedules = [
      makeSchedule({ id: 'bad-cron', cron: '61 * * * *' }),
      makeSchedule({ id: 'bad-date', createdAt: 'not-a-date' }),
    ];
    expect(dueSchedules(schedules, now)).toEqual([]);
  });
});

describe('runDueTeamSchedules', () => {
  it('到期 schedule 创建团队任务并把 lastFiredAt 推进到 now（错过的只补一次）', async () => {
    const now = new Date('2026-01-02T12:00:00');
    listSchedulesMock.mockResolvedValue([
      makeSchedule({ id: 'schedule-1', createdAt: '2026-01-01T00:00:00' }),
    ]);

    await runDueTeamSchedules(now);

    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledWith({
      title: '每日晨报',
      description: '汇总昨天进展',
      priority: 'medium',
      teamId: 'team-1',
      teamName: '晨报团队',
    });
    expect(markScheduleFiredMock).toHaveBeenCalledTimes(1);
    expect(markScheduleFiredMock).toHaveBeenCalledWith('schedule-1', now);
  });

  it('无到期 schedule 时不创建任务；团队已删除时仍创建（不带 teamName）', async () => {
    const now = new Date('2026-01-02T08:00:00');
    listSchedulesMock.mockResolvedValue([
      makeSchedule({ id: 'not-due', cron: '0 20 * * *', createdAt: '2026-01-02T00:00:00' }),
    ]);
    await runDueTeamSchedules(now);
    expect(createTaskMock).not.toHaveBeenCalled();

    listSchedulesMock.mockResolvedValue([
      makeSchedule({ id: 'orphan', teamId: 'team-gone', createdAt: '2026-01-01T00:00:00' }),
    ]);
    await runDueTeamSchedules(new Date('2026-01-02T12:00:00'));
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-gone' }),
    );
    expect(createTaskMock.mock.calls[0][0]).not.toHaveProperty('teamName');
  });

  it('单条创建失败不推进 lastFiredAt，也不影响其它 schedule', async () => {
    const now = new Date('2026-01-02T12:00:00');
    listSchedulesMock.mockResolvedValue([
      makeSchedule({ id: 'failing', createdAt: '2026-01-01T00:00:00' }),
      makeSchedule({ id: 'fine', createdAt: '2026-01-01T00:00:00' }),
    ]);
    createTaskMock
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce({ id: 'task-ok' });

    await runDueTeamSchedules(now);

    expect(createTaskMock).toHaveBeenCalledTimes(2);
    expect(markScheduleFiredMock).toHaveBeenCalledTimes(1);
    expect(markScheduleFiredMock).toHaveBeenCalledWith('fine', now);
  });
});
