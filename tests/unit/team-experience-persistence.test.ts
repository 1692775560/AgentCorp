/**
 * tests/unit/team-experience-persistence.test.ts
 *
 * team-experience 持久层单测（F：Reflexion 式团队记忆，arXiv:2303.11366）：
 * - 写盘走 team-experience.json.tmp + rename 原子写；
 * - append 单条（补 id/createdAt，source 记 taskId），list 按团队隔离；
 * - 每团队封顶 20 条：超出后裁最旧，最新在尾；
 * - team-experience.json 解析损坏时 rename 备份成 .corrupt-<时间戳> 并抛错。
 *
 * 配置目录 mock 到临时目录；fs/promises 包 spy 观察 tmp/rename 调用，真实落盘。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// TEAM_EXPERIENCE_FILE 是模块加载期常量，配置目录必须在 import 前就绪
const configDir = mkdtempSync(join(tmpdir(), 'team-experience-persist-'));

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
  listTeamExperience,
  appendTeamExperience,
  MAX_EXPERIENCE_CARDS_PER_TEAM,
} = await import('../../electron/utils/team-experience');

const experienceFile = join(configDir, 'team-experience.json');
const experienceTmpFile = `${experienceFile}.tmp`;

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

describe('team-experience 持久化 + 原子写', () => {
  it('无记录团队 → 空数组；append 后 tmp+rename 落盘，卡片补 id/createdAt/source', async () => {
    expect(await listTeamExperience('team-a')).toEqual([]);

    const cards = await appendTeamExperience('team-a', { content: '代码任务先定接口再动手', source: 'task-1' });

    const renames = vi.mocked(rename).mock.calls.filter(
      ([from, to]) => String(from) === experienceTmpFile && String(to) === experienceFile,
    );
    expect(renames).toHaveLength(1);
    expect(existsSync(experienceTmpFile)).toBe(false);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ content: '代码任务先定接口再动手', source: 'task-1' });
    expect(cards[0].id).toMatch(/^exp-/);
    expect(typeof cards[0].createdAt).toBe('string');

    // 落盘内容可读回；团队之间隔离
    expect(await listTeamExperience('team-a')).toHaveLength(1);
    expect(await listTeamExperience('team-b')).toEqual([]);
  });

  it(`每团队封顶 ${MAX_EXPERIENCE_CARDS_PER_TEAM} 条：超出裁最旧，最新在尾`, async () => {
    for (let i = 0; i < MAX_EXPERIENCE_CARDS_PER_TEAM + 3; i += 1) {
      await appendTeamExperience('team-a', { content: `经验-${i}`, source: `task-${i}` });
    }

    const cards = await listTeamExperience('team-a');
    expect(cards).toHaveLength(MAX_EXPERIENCE_CARDS_PER_TEAM);
    expect(cards[0].content).toBe('经验-3'); // 最旧 3 条被裁掉
    expect(cards[cards.length - 1].content).toBe(`经验-${MAX_EXPERIENCE_CARDS_PER_TEAM + 2}`);

    // 落盘文件里同样只有 20 条
    const persisted = JSON.parse(readFileSync(experienceFile, 'utf8')) as {
      teams: Record<string, unknown[]>;
    };
    expect(persisted.teams['team-a']).toHaveLength(MAX_EXPERIENCE_CARDS_PER_TEAM);
  });

  it('空内容 / 缺 teamId 拒绝', async () => {
    await expect(appendTeamExperience('team-a', { content: '  ' })).rejects.toThrow(/content/);
    await expect(appendTeamExperience('', { content: 'x' })).rejects.toThrow(/teamId/);
    expect(existsSync(experienceFile)).toBe(false);
  });
});

describe('team-experience 损坏备份', () => {
  it('team-experience.json 损坏 → 备份成 corrupt-<时间戳> 并抛错，不返回空文档', async () => {
    await appendTeamExperience('team-a', { content: '存量经验', source: 'task-0' });
    writeFileSync(experienceFile, '{ "teams": {"team-a": [{"id": "exp-1"');

    await expect(listTeamExperience('team-a')).rejects.toThrow(/corrupted/);

    const backups = readdirSync(configDir).filter((n) => n.startsWith('team-experience.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(configDir, backups[0]), 'utf8')).toBe('{ "teams": {"team-a": [{"id": "exp-1"');
    expect(existsSync(experienceFile)).toBe(false);
  });
});
