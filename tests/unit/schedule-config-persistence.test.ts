/**
 * tests/unit/schedule-config-persistence.test.ts
 *
 * schedule-config 持久层单测（与 task-config-persistence.test.ts 同套路）：
 * - 写盘走 schedules.json.tmp + rename 原子写；
 * - CRUD + markScheduleFired 单调推进；
 * - schedules.json 解析损坏时 rename 备份成 schedules.json.corrupt-<时间戳>
 *   并抛错，绝不静默返回空数组；
 * - cron 表达式校验（非法表达式拒绝创建/更新）。
 *
 * 配置目录 mock 到临时目录；fs/promises 包 spy 观察 tmp/rename 调用，真实落盘。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// SCHEDULES_FILE 是模块加载期常量，配置目录必须在 import 前就绪
const configDir = mkdtempSync(join(tmpdir(), 'schedule-config-persist-'));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => configDir, getAppPath: () => configDir },
}));

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawConfigDir: () => configDir,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('fs/promises')>();
  return {
    ...orig,
    writeFile: vi.fn(orig.writeFile),
    rename: vi.fn(orig.rename),
  };
});

import { writeFile, rename } from 'fs/promises';

const {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  markScheduleFired,
} = await import('../../electron/utils/schedule-config');

const schedulesFile = join(configDir, 'schedules.json');
const schedulesTmpFile = `${schedulesFile}.tmp`;

function cleanConfigDir() {
  for (const name of readdirSync(configDir)) {
    rmSync(join(configDir, name), { recursive: true, force: true });
  }
}

beforeEach(() => {
  cleanConfigDir();
  vi.mocked(writeFile).mockClear();
  vi.mocked(rename).mockClear();
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('schedule-config CRUD + 原子写', () => {
  it('写盘先落 schedules.json.tmp 再 rename 成 schedules.json，tmp 不残留', async () => {
    const schedule = await createSchedule({
      teamId: 'team-1',
      title: '每日晨报',
      instruction: '汇总昨天进展',
      cron: '0 9 * * *',
    });

    const tmpWrites = vi.mocked(writeFile).mock.calls.filter(([p]) => String(p) === schedulesTmpFile);
    expect(tmpWrites.length).toBeGreaterThan(0);
    const renames = vi.mocked(rename).mock.calls.filter(
      ([from, to]) => String(from) === schedulesTmpFile && String(to) === schedulesFile,
    );
    expect(renames).toHaveLength(1);

    expect(existsSync(schedulesTmpFile)).toBe(false);
    const persisted = JSON.parse(readFileSync(schedulesFile, 'utf8')) as {
      schedules: Array<{ id: string }>;
    };
    expect(persisted.schedules.map((s) => s.id)).toEqual([schedule.id]);

    const listed = await listSchedules();
    expect(listed.map((s) => s.id)).toEqual([schedule.id]);
    expect(listed[0].enabled).toBe(true);
    expect(listed[0].lastFiredAt).toBeUndefined();
  });

  it('update / delete / 非法 cron 校验', async () => {
    const schedule = await createSchedule({
      teamId: 'team-1',
      title: '周报',
      instruction: '汇总本周进展',
      cron: '0 9 * * 1',
    });

    const updated = await updateSchedule(schedule.id, { enabled: false, cron: '0 18 * * 5' });
    expect(updated.enabled).toBe(false);
    expect(updated.cron).toBe('0 18 * * 5');

    await expect(updateSchedule(schedule.id, { cron: 'not a cron' })).rejects.toThrow(/Invalid cron/);
    await expect(
      createSchedule({ teamId: 'team-1', title: 'x', instruction: 'y', cron: '61 * * * *' }),
    ).rejects.toThrow(/Invalid cron/);
    await expect(updateSchedule('schedule-missing', { enabled: true })).rejects.toThrow(/not found/);

    await deleteSchedule(schedule.id);
    expect(await listSchedules()).toEqual([]);
    await expect(deleteSchedule(schedule.id)).rejects.toThrow(/not found/);
  });

  it('markScheduleFired 单调推进，不回退', async () => {
    const schedule = await createSchedule({
      teamId: 'team-1',
      title: '心跳',
      instruction: 'ping',
      cron: '* * * * *',
    });

    const later = new Date('2026-06-01T09:05:00.000Z');
    await markScheduleFired(schedule.id, later);
    expect((await listSchedules())[0].lastFiredAt).toBe(later.toISOString());

    // 更早的时间不覆盖
    await markScheduleFired(schedule.id, new Date('2026-06-01T09:00:00.000Z'));
    expect((await listSchedules())[0].lastFiredAt).toBe(later.toISOString());
  });
});

describe('schedule-config 损坏备份', () => {
  it('schedules.json 损坏 → 备份成 corrupt-<时间戳> 并抛错，不返回空数组', async () => {
    await createSchedule({
      teamId: 'team-1',
      title: '存量',
      instruction: 'keep',
      cron: '0 9 * * *',
    });
    // 模拟崩溃截断：半个 JSON
    writeFileSync(schedulesFile, '{ "schedules": [{"id": "schedule-1"');

    await expect(listSchedules()).rejects.toThrow(/corrupted/);

    const backups = readdirSync(configDir).filter((n) => n.startsWith('schedules.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(configDir, backups[0]), 'utf8')).toBe('{ "schedules": [{"id": "schedule-1"');
    // 坏文件已 rename 走，不会反复污染后续读取
    expect(existsSync(schedulesFile)).toBe(false);
  });

  it('损坏文件被抛错拦截：不存在「以空文档为基准把坏文件盖掉」的静默路径', async () => {
    writeFileSync(schedulesFile, 'not json at all');

    await expect(listSchedules()).rejects.toThrow(/corrupted/);
    // 备份后 schedules.json 缺失 → 下一次写从空文档重新开始，旧数据只留在备份里
    const created = await createSchedule({
      teamId: 'team-1',
      title: '重建',
      instruction: 'rebuild',
      cron: '*/30 * * * *',
    });
    const persisted = JSON.parse(readFileSync(schedulesFile, 'utf8')) as {
      schedules: Array<{ id: string }>;
    };
    expect(persisted.schedules.map((s) => s.id)).toEqual([created.id]);
  });
});
