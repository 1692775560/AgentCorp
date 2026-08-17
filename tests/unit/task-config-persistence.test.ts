/**
 * tests/unit/task-config-persistence.test.ts
 *
 * 持久层健壮性单测（Bug 1）：
 * - task-config：写盘走 tasks.json.tmp + rename 原子写；
 * - task-config：tasks.json 解析损坏时 rename 备份成 tasks.json.corrupt-<时间戳>
 *   并抛错，绝不静默返回空数组（防止后续读-改-写以空文档为基准清空全部任务）；
 * - openclaw-runtime-metadata（teams/agent 元数据侧车）：同样的原子写 +
 *   备份+抛错语义。
 *
 * 配置目录 mock 到临时目录；fs/promises 包 spy 观察 tmp/rename 调用，真实落盘。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// TASKS_FILE / RUNTIME_METADATA_FILE 是模块加载期常量，配置目录必须在 import 前就绪
const configDir = mkdtempSync(join(tmpdir(), 'task-config-persist-'));

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

const { createTask, listTaskSnapshots } = await import('../../electron/utils/task-config');
const { readStoredTeams, writeStoredTeams } = await import('../../electron/utils/openclaw-runtime-metadata');

const tasksFile = join(configDir, 'tasks.json');
const tasksTmpFile = `${tasksFile}.tmp`;
const metadataFile = join(configDir, 'agentcorp-runtime-metadata.json');
const metadataTmpFile = `${metadataFile}.tmp`;

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

describe('task-config 原子写', () => {
  it('写盘先落 tasks.json.tmp 再 rename 成 tasks.json，tmp 不残留', async () => {
    const task = await createTask({
      title: '原子写验证',
      description: '',
      priority: 'medium',
    });

    const tmpWrites = vi.mocked(writeFile).mock.calls.filter(([p]) => String(p) === tasksTmpFile);
    expect(tmpWrites.length).toBeGreaterThan(0);
    const renames = vi.mocked(rename).mock.calls.filter(
      ([from, to]) => String(from) === tasksTmpFile && String(to) === tasksFile,
    );
    expect(renames).toHaveLength(1);

    expect(existsSync(tasksTmpFile)).toBe(false);
    const persisted = JSON.parse(readFileSync(tasksFile, 'utf8')) as { tasks: Array<{ id: string }> };
    expect(persisted.tasks.map((t) => t.id)).toEqual([task.id]);

    const listed = await listTaskSnapshots();
    expect(listed.map((t) => t.id)).toEqual([task.id]);
  });

  it('tasks.json 损坏 → 备份成 corrupt-<时间戳> 并抛错，不返回空数组', async () => {
    await createTask({ title: '存量任务', description: '', priority: 'low' });
    // 模拟崩溃截断：半个 JSON
    writeFileSync(tasksFile, '{ "tasks": [{"id": "task-1"');

    await expect(listTaskSnapshots()).rejects.toThrow(/corrupted/);

    const backups = readdirSync(configDir).filter((n) => n.startsWith('tasks.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(configDir, backups[0]), 'utf8')).toBe('{ "tasks": [{"id": "task-1"');
    // 坏文件已 rename 走，不会反复污染后续读取
    expect(existsSync(tasksFile)).toBe(false);
  });

  it('损坏文件被抛错拦截：不存在「以空文档为基准把坏文件盖掉」的静默路径', async () => {
    writeFileSync(tasksFile, 'not json at all');

    // 读抛错；同一次损坏也会被写路径（读-改-写里的读）拦截
    await expect(listTaskSnapshots()).rejects.toThrow(/corrupted/);
    // 备份后 tasks.json 缺失 → 下一次写从空文档重新开始，旧数据只留在备份里
    const created = await createTask({ title: '重建', description: '', priority: 'high' });
    const persisted = JSON.parse(readFileSync(tasksFile, 'utf8')) as { tasks: Array<{ id: string }> };
    expect(persisted.tasks.map((t) => t.id)).toEqual([created.id]);
  });
});

describe('openclaw-runtime-metadata（teams 侧车）同样语义', () => {
  it('写盘走 tmp + rename 原子写', async () => {
    await writeStoredTeams([]);

    const renames = vi.mocked(rename).mock.calls.filter(
      ([from, to]) => String(from) === metadataTmpFile && String(to) === metadataFile,
    );
    expect(renames).toHaveLength(1);
    expect(existsSync(metadataTmpFile)).toBe(false);
    expect(existsSync(metadataFile)).toBe(true);
  });

  it('metadata 损坏 → 备份成 corrupt-<时间戳> 并抛错，不回退空状态', async () => {
    await writeStoredTeams([
      {
        id: 'team-1',
        name: '测试团队',
        leaderId: 'agent-1',
        memberIds: [],
        description: '',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    writeFileSync(metadataFile, 'corrupt!!!');

    await expect(readStoredTeams()).rejects.toThrow(/corrupted/);

    const backups = readdirSync(configDir).filter((n) =>
      n.startsWith('agentcorp-runtime-metadata.json.corrupt-'),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(configDir, backups[0]), 'utf8')).toBe('corrupt!!!');
    expect(existsSync(metadataFile)).toBe(false);
  });
});
