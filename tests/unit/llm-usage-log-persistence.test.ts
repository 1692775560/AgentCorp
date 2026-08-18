/**
 * tests/unit/llm-usage-log-persistence.test.ts
 *
 * usage-log 持久化单测（electron/utils/llm-usage-log.ts），套路对齐
 * task-config-persistence.test.ts：
 * - append 写盘走 usage-log.json.tmp + rename 原子写；
 * - 多次 append 累积、读回一致；
 * - 超出 maxEntries 丢弃最旧记录；
 * - 文件损坏时 rename 备份成 usage-log.json.corrupt-<时间戳> 并抛错，
 *   绝不静默以空文档覆盖。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// USAGE_LOG_FILE 是模块加载期常量，配置目录必须在 import 前就绪
const configDir = mkdtempSync(join(tmpdir(), 'llm-usage-log-persist-'));

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

const { appendLlmUsageRecords, listLlmUsageRecords } = await import(
  '../../electron/utils/llm-usage-log'
);

const usageFile = join(configDir, 'usage-log.json');
const usageTmpFile = `${usageFile}.tmp`;

function makeRecord(agentId: string, totalTokens = 10) {
  return {
    ts: new Date().toISOString(),
    agentId,
    promptTokens: totalTokens,
    completionTokens: 0,
    totalTokens,
  };
}

beforeEach(() => {
  for (const name of readdirSync(configDir)) {
    rmSync(join(configDir, name), { recursive: true, force: true });
  }
  vi.mocked(writeFile).mockClear();
  vi.mocked(rename).mockClear();
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('llm-usage-log 原子写', () => {
  it('写盘先落 usage-log.json.tmp 再 rename 成 usage-log.json，tmp 不残留', async () => {
    await appendLlmUsageRecords([makeRecord('a1')]);

    const tmpWrites = vi.mocked(writeFile).mock.calls.filter(([p]) => String(p) === usageTmpFile);
    expect(tmpWrites.length).toBeGreaterThan(0);
    const renames = vi.mocked(rename).mock.calls.filter(
      ([from, to]) => String(from) === usageTmpFile && String(to) === usageFile,
    );
    expect(renames).toHaveLength(1);

    expect(existsSync(usageTmpFile)).toBe(false);
    const persisted = JSON.parse(readFileSync(usageFile, 'utf8')) as { entries: Array<{ agentId?: string }> };
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0].agentId).toBe('a1');
  });
});

describe('llm-usage-log append 语义', () => {
  it('多次 append 累积，读回顺序与写入一致', async () => {
    await appendLlmUsageRecords([makeRecord('a1')]);
    await appendLlmUsageRecords([makeRecord('a2'), makeRecord('a3')]);

    const entries = await listLlmUsageRecords();
    expect(entries.map((e) => e.agentId)).toEqual(['a1', 'a2', 'a3']);
  });

  it('空批次不写盘', async () => {
    await appendLlmUsageRecords([]);
    expect(vi.mocked(writeFile).mock.calls.filter(([p]) => String(p) === usageTmpFile)).toHaveLength(0);
    expect(existsSync(usageFile)).toBe(false);
  });

  it('超出 maxEntries 丢弃最旧记录', async () => {
    await appendLlmUsageRecords([makeRecord('old-1'), makeRecord('old-2')], 3);
    await appendLlmUsageRecords([makeRecord('new-1'), makeRecord('new-2')], 3);

    const entries = await listLlmUsageRecords();
    expect(entries.map((e) => e.agentId)).toEqual(['old-2', 'new-1', 'new-2']);
  });
});

describe('llm-usage-log 损坏保护', () => {
  it('JSON 损坏时 rename 备份并抛错，绝不静默清空', async () => {
    writeFileSync(usageFile, '{ broken json', 'utf8');

    await expect(appendLlmUsageRecords([makeRecord('a1')])).rejects.toThrow('corrupted');

    const backups = readdirSync(configDir).filter((n) => n.startsWith('usage-log.json.corrupt-'));
    expect(backups).toHaveLength(1);
    // 备份保留原始损坏内容
    expect(readFileSync(join(configDir, backups[0]), 'utf8')).toBe('{ broken json');
    // 不生成覆盖性的新文件
    expect(existsSync(usageFile)).toBe(false);
  });
});
