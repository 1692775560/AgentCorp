import { createTask } from './task-config';
import { listSchedules, markScheduleFired } from './schedule-config';
import { readTeamsConfig } from './team-config';
import { nextFireAfter } from '../../shared/schedule-cron';
import { logger } from './logger';
import type { TeamSchedule } from '../../src/types/schedule';

export interface DueSchedule {
  schedule: TeamSchedule;
  /** 理论触发时刻（分钟粒度），仅供观测/测试 */
  fireAt: Date;
}

/**
 * 纯函数：从 schedules 里筛出 now 时刻到期的启用项。
 * 基准为 lastFiredAt ?? createdAt，nextFireAfter 严格大于基准，
 * 因此 lastFiredAt 单调推进后同一触发点不会重复命中。
 * 进程睡眠错过的多次触发在这里只会出现一次（补发一次），
 * 由调用方触发后把 lastFiredAt 推进到 now。
 */
export function dueSchedules(schedules: TeamSchedule[], now: Date): DueSchedule[] {
  const due: DueSchedule[] = [];
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    const base = new Date(schedule.lastFiredAt ?? schedule.createdAt);
    if (Number.isNaN(base.getTime())) continue;
    const fireAt = nextFireAfter(schedule.cron, base);
    if (fireAt && fireAt.getTime() <= now.getTime()) {
      due.push({ schedule, fireAt });
    }
  }
  return due;
}

const TICK_INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * 扫一遍启用中的 schedules，到期的逐条创建团队任务（status:'todo'，由
 * autoWorker 管线自动领取执行）并推进 lastFiredAt。
 * 单条失败只记日志不影响其它 schedule；创建失败不推进 lastFiredAt，下轮重试。
 */
export async function runDueTeamSchedules(now: Date = new Date()): Promise<void> {
  // setInterval 不等待异步回调，上一轮没跑完就跳过本轮，避免重入叠任务
  if (running) return;
  running = true;
  try {
    const schedules = await listSchedules();
    const due = dueSchedules(schedules, now);
    if (due.length === 0) return;

    const teams = await readTeamsConfig();
    for (const { schedule, fireAt } of due) {
      try {
        const team = teams.find((item) => item.id === schedule.teamId);
        const task = await createTask({
          title: schedule.title,
          description: schedule.instruction,
          priority: 'medium',
          teamId: schedule.teamId,
          ...(team ? { teamName: team.name } : {}),
        });
        // lastFiredAt 推进到 now 而非 fireAt：错过的多次触发只补发这一次
        await markScheduleFired(schedule.id, now);
        logger.info(
          `[team-scheduler] Fired schedule ${schedule.id} for team ${schedule.teamId} ` +
          `(due at ${fireAt.toISOString()}), created task ${task.id}`,
        );
      } catch (error) {
        logger.error(`[team-scheduler] Failed to fire schedule ${schedule.id}:`, error);
      }
    }
  } catch (error) {
    logger.error('[team-scheduler] Failed to run due schedules:', error);
  } finally {
    running = false;
  }
}

/** 主进程启动时挂接：每 60s 扫一次，启动时先补扫一轮。 */
export function startTeamScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runDueTeamSchedules();
  }, TICK_INTERVAL_MS);
  // 不阻止进程退出
  if (typeof timer === 'object' && typeof timer.unref === 'function') {
    timer.unref();
  }
  void runDueTeamSchedules();
}

export function stopTeamScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
