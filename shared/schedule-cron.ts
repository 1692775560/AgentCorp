/**
 * shared/schedule-cron.ts
 *
 * 5 字段 cron 子集解析（分时日月周），零依赖，纯函数。
 * 主进程调度器（electron/utils/team-scheduler.ts）、渲染层表单校验
 * （src/components/team-map/TeamScheduleSheet.tsx）与单测共用。
 *
 * 支持语法：星号通配、步进（如「每 5 分钟」）、具体数字、逗号数字列表。
 * 周字段 0 和 7 都表示周日。
 * 日/周语义沿用 Vixie cron：两者都受限（非 `*`）时任一匹配即命中，
 * 只有一个受限时按该字段过滤。
 */

export interface CronFieldSpec {
  /** 是否为 `*`（不限制） */
  any: boolean;
  /** any=false 时的合法取值集合 */
  values: Set<number>;
}

export interface ParsedCron {
  minute: CronFieldSpec;
  hour: CronFieldSpec;
  dayOfMonth: CronFieldSpec;
  month: CronFieldSpec;
  dayOfWeek: CronFieldSpec;
}

interface FieldRange {
  min: number;
  max: number;
  /** 取值归一化（周日字段把 7 折成 0） */
  normalize?: (value: number) => number;
}

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // 分
  { min: 0, max: 23 }, // 时
  { min: 1, max: 31 }, // 日
  { min: 1, max: 12 }, // 月
  { min: 0, max: 7, normalize: (value) => (value === 7 ? 0 : value) }, // 周
];

function parseField(text: string, range: FieldRange): CronFieldSpec | null {
  if (text === '*') {
    return { any: true, values: new Set() };
  }

  const stepMatch = /^\*\/(\d+)$/.exec(text);
  if (stepMatch) {
    const step = Number.parseInt(stepMatch[1], 10);
    if (step <= 0) return null;
    const values = new Set<number>();
    for (let value = range.min; value <= range.max; value += step) {
      values.add(range.normalize ? range.normalize(value) : value);
    }
    return { any: false, values };
  }

  const parts = text.split(',');
  const values = new Set<number>();
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number.parseInt(part, 10);
    if (value < range.min || value > range.max) return null;
    values.add(range.normalize ? range.normalize(value) : value);
  }
  return values.size > 0 ? { any: false, values } : null;
}

/** 解析 5 字段 cron 表达式；非法返回 null。 */
export function parseCronExpression(cron: string): ParsedCron | null {
  if (typeof cron !== 'string') return null;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const parsed = fields.map((field, index) => parseField(field, FIELD_RANGES[index]));
  if (parsed.some((field) => field === null)) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed as CronFieldSpec[];
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

export function isValidCronExpression(cron: string): boolean {
  return parseCronExpression(cron) !== null;
}

function fieldMatches(spec: CronFieldSpec, value: number): boolean {
  return spec.any || spec.values.has(value);
}

function dayMatches(parsed: ParsedCron, date: Date): boolean {
  const domMatches = fieldMatches(parsed.dayOfMonth, date.getDate());
  const dowMatches = fieldMatches(parsed.dayOfWeek, date.getDay());
  if (parsed.dayOfMonth.any && parsed.dayOfWeek.any) return true;
  if (parsed.dayOfMonth.any) return dowMatches;
  if (parsed.dayOfWeek.any) return domMatches;
  // Vixie cron：日/周同时受限时是 OR 关系
  return domMatches || dowMatches;
}

/** 搜索上限：4 年（覆盖闰年），超出即认为永不触发（如 2 月 30 日）。 */
const MAX_SEARCH_MS = 4 * 366 * 24 * 60 * 60 * 1000;

/**
 * 计算 after 之后（严格大于 after，粒度 1 分钟）的下一个触发时间。
 * 表达式非法或搜索窗口内无触发时间（如 2 月 30 日）时返回 null。
 */
export function nextFireAfter(cron: string, after: Date): Date | null {
  const parsed = parseCronExpression(cron);
  if (!parsed) return null;
  if (Number.isNaN(after.getTime())) return null;

  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const deadline = after.getTime() + MAX_SEARCH_MS;

  while (candidate.getTime() <= deadline) {
    if (!fieldMatches(parsed.month, candidate.getMonth() + 1)) {
      // 跳到次月 1 日 00:00
      candidate.setDate(1);
      candidate.setHours(0, 0, 0, 0);
      candidate.setMonth(candidate.getMonth() + 1);
      continue;
    }
    if (!dayMatches(parsed, candidate)) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    if (!fieldMatches(parsed.hour, candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!fieldMatches(parsed.minute, candidate.getMinutes())) {
      candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(candidate.getTime());
  }
  return null;
}
