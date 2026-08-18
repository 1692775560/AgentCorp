/**
 * tests/unit/member-stats-persistence.test.ts
 *
 * member-stats 持久层 + toPerformance 投影单测（D：DyLAN 贡献度，arXiv:2310.02170）：
 * - 写盘走 member-stats.json.tmp + rename 原子写；
 * - recordMemberOutcome 增量语义：tasks+1 / approved 则 passed+1 / totalRounds 累加；
 * - member-stats.json 解析损坏时 rename 备份成 .corrupt-<时间戳> 并抛错，
 *   绝不静默返回空文档；
 * - toPerformance 边界：tasks=0（新成员）approvedRate 返回 1（不罚）。
 *
 * 配置目录 mock 到临时目录；fs/promises 包 spy 观察 tmp/rename 调用，真实落盘。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// MEMBER_STATS_FILE 是模块加载期常量，配置目录必须在 import 前就绪
const configDir = mkdtempSync(join(tmpdir(), 'member-stats-persist-'));

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

const { getMemberStats, recordMemberOutcome } = await import('../../electron/utils/member-stats');
const { toPerformance } = await import('../../src/types/performance');

const statsFile = join(configDir, 'member-stats.json');
const statsTmpFile = `${statsFile}.tmp`;

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

describe('member-stats 持久化 + 原子写', () => {
  it('空文件起步 → 空快照；record 后 tmp+rename 落盘且 tmp 不残留', async () => {
    expect(await getMemberStats()).toEqual({});

    const snapshot = await recordMemberOutcome('agent-1', { approved: true, rounds: 2 });

    const tmpWrites = vi.mocked(writeFile).mock.calls.filter(([p]) => String(p) === statsTmpFile);
    expect(tmpWrites.length).toBeGreaterThan(0);
    const renames = vi.mocked(rename).mock.calls.filter(
      ([from, to]) => String(from) === statsTmpFile && String(to) === statsFile,
    );
    expect(renames).toHaveLength(1);
    expect(existsSync(statsTmpFile)).toBe(false);

    expect(snapshot['agent-1']).toMatchObject({ tasks: 1, passed: 1, totalRounds: 2 });
    expect(typeof snapshot['agent-1'].updatedAt).toBe('string');

    const persisted = JSON.parse(readFileSync(statsFile, 'utf8')) as {
      members: Record<string, { tasks: number }>;
    };
    expect(persisted.members['agent-1'].tasks).toBe(1);
  });

  it('增量语义：approved 才累计 passed；rounds 累加；多成员互不影响', async () => {
    await recordMemberOutcome('agent-1', { approved: true, rounds: 1 });
    await recordMemberOutcome('agent-1', { approved: false, rounds: 3 });
    await recordMemberOutcome('agent-1', { approved: true, rounds: 2 });
    await recordMemberOutcome('agent-2', { approved: false, rounds: 1 });

    const stats = await getMemberStats();
    expect(stats['agent-1']).toMatchObject({ tasks: 3, passed: 2, totalRounds: 6 });
    expect(stats['agent-2']).toMatchObject({ tasks: 1, passed: 0, totalRounds: 1 });
  });

  it('非法输入拒绝：缺 agentId / 非法 rounds 抛错', async () => {
    await expect(recordMemberOutcome('', { approved: true, rounds: 1 })).rejects.toThrow(/agentId/);
    await expect(recordMemberOutcome('a', { approved: true, rounds: -1 })).rejects.toThrow(/rounds/);
    await expect(recordMemberOutcome('a', { approved: true, rounds: NaN })).rejects.toThrow(/rounds/);
    // 抛错不落盘
    expect(existsSync(statsFile)).toBe(false);
  });
});

describe('member-stats 损坏备份', () => {
  it('member-stats.json 损坏 → 备份成 corrupt-<时间戳> 并抛错，不返回空文档', async () => {
    await recordMemberOutcome('agent-1', { approved: true, rounds: 1 });
    // 模拟崩溃截断：半个 JSON
    writeFileSync(statsFile, '{ "members": {"agent-1": {"tasks": 1');

    await expect(getMemberStats()).rejects.toThrow(/corrupted/);

    const backups = readdirSync(configDir).filter((n) => n.startsWith('member-stats.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(configDir, backups[0]), 'utf8')).toBe('{ "members": {"agent-1": {"tasks": 1');
    // 坏文件已 rename 走，不会反复污染后续读取
    expect(existsSync(statsFile)).toBe(false);
  });

  it('损坏文件被抛错拦截后，下一次写从空文档重建，旧数据只留在备份里', async () => {
    writeFileSync(statsFile, 'not json at all');
    await expect(getMemberStats()).rejects.toThrow(/corrupted/);

    await recordMemberOutcome('agent-9', { approved: false, rounds: 4 });
    const stats = await getMemberStats();
    expect(Object.keys(stats)).toEqual(['agent-9']);
    expect(stats['agent-9']).toMatchObject({ tasks: 1, passed: 0, totalRounds: 4 });
  });
});

describe('toPerformance 投影（tasks=0 新成员不罚）', () => {
  it('tasks=0 / 无记录 → approvedRate=1, avgRounds=0', () => {
    expect(toPerformance(undefined)).toEqual({ tasks: 0, approvedRate: 1, avgRounds: 0 });
    expect(toPerformance(null)).toEqual({ tasks: 0, approvedRate: 1, avgRounds: 0 });
    expect(toPerformance({ tasks: 0, passed: 0, totalRounds: 0, updatedAt: '' })).toEqual({
      tasks: 0,
      approvedRate: 1,
      avgRounds: 0,
    });
  });

  it('正常投影：approvedRate=passed/tasks，avgRounds=totalRounds/tasks', () => {
    expect(toPerformance({ tasks: 4, passed: 3, totalRounds: 6, updatedAt: '' })).toEqual({
      tasks: 4,
      approvedRate: 0.75,
      avgRounds: 1.5,
    });
    // 全部失败 → approvedRate 0（有记录则按真实表现计）
    expect(toPerformance({ tasks: 2, passed: 0, totalRounds: 2, updatedAt: '' }).approvedRate).toBe(0);
  });
});
