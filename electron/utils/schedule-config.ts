import { constants } from 'fs';
import { access, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { withConfigLock } from './config-mutex';
import { getOpenClawConfigDir } from './paths';
import { logger } from './logger';
import { isValidCronExpression } from '../../shared/schedule-cron';
import type {
  CreateScheduleRequest,
  TeamSchedule,
  UpdateScheduleRequest,
} from '../../src/types/schedule';

interface ScheduleConfigDocument {
  schedules?: TeamSchedule[];
}

const SCHEDULES_FILE = join(getOpenClawConfigDir(), 'schedules.json');
const SCHEDULES_TMP_FILE = `${SCHEDULES_FILE}.tmp`;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureScheduleConfigDir(): Promise<void> {
  await mkdir(getOpenClawConfigDir(), { recursive: true });
}

/**
 * 把损坏的配置文件 rename 成 `<file>.corrupt-<时间戳>` 备份，
 * 避免后续写操作以「空文档」为基准把残留数据盖掉。
 * 返回备份路径；备份失败返回 null（原文件保持不动）。
 */
async function backupCorruptFile(filePath: string): Promise<string | null> {
  const backupPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    await rename(filePath, backupPath);
    return backupPath;
  } catch (backupError) {
    logger.error(`Failed to back up corrupt config file: ${filePath}`, backupError);
    return null;
  }
}

async function readScheduleDocument(): Promise<ScheduleConfigDocument> {
  await ensureScheduleConfigDir();
  if (!(await fileExists(SCHEDULES_FILE))) {
    return { schedules: [] };
  }

  try {
    const content = await readFile(SCHEDULES_FILE, 'utf8');
    return JSON.parse(content) as ScheduleConfigDocument;
  } catch (error) {
    // 解析失败绝不能返回空数组——那会让下一次写操作以空文档为基准
    // 读-改-写，把全部 schedule 永久覆盖掉。备份坏文件后抛错，由调用方降级（HTTP 500）。
    const backupPath = await backupCorruptFile(SCHEDULES_FILE);
    logger.error('Failed to read schedule config', error);
    throw new Error(
      `Schedule config is corrupted (backed up to ${backupPath ?? 'unavailable'}): ${SCHEDULES_FILE}`,
      { cause: error },
    );
  }
}

async function writeScheduleDocument(document: ScheduleConfigDocument): Promise<void> {
  await ensureScheduleConfigDir();
  // 原子写：先写 tmp 再 rename，避免崩溃截断留下半个 JSON
  await writeFile(SCHEDULES_TMP_FILE, JSON.stringify({ schedules: document.schedules ?? [] }, null, 2), 'utf8');
  await rename(SCHEDULES_TMP_FILE, SCHEDULES_FILE);
}

function findScheduleIndex(schedules: TeamSchedule[], scheduleId: string): number {
  return schedules.findIndex((schedule) => schedule.id === scheduleId);
}

export async function listSchedules(): Promise<TeamSchedule[]> {
  const document = await readScheduleDocument();
  return document.schedules ?? [];
}

export async function createSchedule(input: CreateScheduleRequest): Promise<TeamSchedule> {
  const title = input.title?.trim();
  const instruction = input.instruction?.trim();
  const cron = input.cron?.trim();

  if (!input.teamId) {
    throw new Error('teamId is required');
  }
  if (!title) {
    throw new Error('title is required');
  }
  if (!instruction) {
    throw new Error('instruction is required');
  }
  if (!cron || !isValidCronExpression(cron)) {
    throw new Error(`Invalid cron expression: ${input.cron}`);
  }

  return withConfigLock(async () => {
    const document = await readScheduleDocument();
    const schedules = [...(document.schedules ?? [])];
    const schedule: TeamSchedule = {
      id: `schedule-${randomUUID()}`,
      teamId: input.teamId,
      title,
      instruction,
      cron,
      enabled: input.enabled ?? true,
      createdAt: new Date().toISOString(),
    };

    schedules.push(schedule);
    await writeScheduleDocument({ schedules });
    return schedule;
  });
}

export async function updateSchedule(
  scheduleId: string,
  updates: UpdateScheduleRequest,
): Promise<TeamSchedule> {
  if (updates.cron !== undefined && !isValidCronExpression(updates.cron.trim())) {
    throw new Error(`Invalid cron expression: ${updates.cron}`);
  }

  return withConfigLock(async () => {
    const document = await readScheduleDocument();
    const schedules = [...(document.schedules ?? [])];
    const index = findScheduleIndex(schedules, scheduleId);
    if (index === -1) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    const schedule = schedules[index];
    const updatedSchedule: TeamSchedule = {
      ...schedule,
      ...(updates.title !== undefined && { title: updates.title.trim() }),
      ...(updates.instruction !== undefined && { instruction: updates.instruction.trim() }),
      ...(updates.cron !== undefined && { cron: updates.cron.trim() }),
      ...(updates.enabled !== undefined && { enabled: updates.enabled }),
    };

    schedules[index] = updatedSchedule;
    await writeScheduleDocument({ schedules });
    return updatedSchedule;
  });
}

export async function deleteSchedule(scheduleId: string): Promise<void> {
  return withConfigLock(async () => {
    const document = await readScheduleDocument();
    const schedules = [...(document.schedules ?? [])];
    const nextSchedules = schedules.filter((schedule) => schedule.id !== scheduleId);
    if (nextSchedules.length === schedules.length) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    await writeScheduleDocument({ schedules: nextSchedules });
  });
}

/**
 * 触发后推进 lastFiredAt（单调，不回退）。调度器补发策略：
 * 进程睡眠错过的多次触发只补一次，lastFiredAt 直接推进到触发时刻的 now。
 */
export async function markScheduleFired(scheduleId: string, firedAt: Date): Promise<void> {
  return withConfigLock(async () => {
    const document = await readScheduleDocument();
    const schedules = [...(document.schedules ?? [])];
    const index = findScheduleIndex(schedules, scheduleId);
    if (index === -1) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    const schedule = schedules[index];
    const firedAtIso = firedAt.toISOString();
    if (schedule.lastFiredAt && schedule.lastFiredAt >= firedAtIso) {
      return;
    }

    schedules[index] = { ...schedule, lastFiredAt: firedAtIso };
    await writeScheduleDocument({ schedules });
  });
}
