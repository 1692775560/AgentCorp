/**
 * src/types/schedule.ts
 * 团队定时任务（schedule）：到点由主进程调度器自动创建一条团队任务（status:'todo'），
 * 走 autoWorker 管线执行。持久化在 ~/.openclaw 配置目录的 schedules.json。
 */

export interface TeamSchedule {
  id: string;
  teamId: string;
  /** 任务标题，触发时作为创建任务的 title */
  title: string;
  /** 指令文本，触发时作为创建任务的 description */
  instruction: string;
  /** 5 字段 cron 表达式（分 时 日 月 周），子集见 shared/schedule-cron.ts */
  cron: string;
  enabled: boolean;
  /** 上次触发时间（ISO 字符串），未触发过则缺省 */
  lastFiredAt?: string;
  createdAt: string;
}

export interface CreateScheduleRequest {
  teamId: string;
  title: string;
  instruction: string;
  cron: string;
  enabled?: boolean;
}

export interface UpdateScheduleRequest {
  title?: string;
  instruction?: string;
  cron?: string;
  enabled?: boolean;
}

export interface SchedulesSnapshot {
  success: boolean;
  schedules: TeamSchedule[];
}
