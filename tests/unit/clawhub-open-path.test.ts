/**
 * tests/unit/clawhub-open-path.test.ts
 *
 * ClawHub openSkillReadme / openSkillPath 的路径安全约束：
 * - slug/skillKey 的「..」穿越与绝对路径注入一律拒绝（解析结果必须落在
 *   workDir/skills 根目录内），最终交给 shell.openPath 的路径不可逃逸；
 * - 客户端可控 baseDir 参数已移除（routes/skills.ts 同步收窄）；
 * - 正常 skill 目录与 manifest frontmatter name 解析不受影响。
 *
 * 配置目录与 electron.shell 均 mock：openPath 仅记录调用参数，不真实打开。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'clawhub-open-path-'));
const openedPaths: string[] = [];

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => configDir, getAppPath: () => configDir },
  shell: {
    openPath: vi.fn(async (target: string) => {
      openedPaths.push(target);
      return ''; // 空串 = 成功（shell.openPath 约定）
    }),
  },
}));

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawConfigDir: () => configDir,
  ensureDir: (dir: string) => mkdirSync(dir, { recursive: true }),
  getClawHubCliBinPath: () => '/nonexistent/clawhub-bin',
  getClawHubCliEntryPath: () => '/nonexistent/clawhub-entry.js',
  quoteForCmd: (s: string) => s,
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { ClawHubService } = await import('../../electron/gateway/clawhub');

const skillsRoot = join(configDir, 'skills');
// 穿越目标：存在于文件系统、但在 skills 根目录之外
const escapeTarget = join(configDir, 'outside-secret');

function fixture() {
  mkdirSync(join(skillsRoot, 'legit-skill'), { recursive: true });
  writeFileSync(join(skillsRoot, 'legit-skill', 'SKILL.md'), '# legit\n');
  // 只有 frontmatter name、目录名与 skillKey 不同的 skill
  mkdirSync(join(skillsRoot, 'renamed-dir'), { recursive: true });
  writeFileSync(
    join(skillsRoot, 'renamed-dir', 'SKILL.md'),
    '---\nname: Manifest Skill\n---\n# x\n',
  );
  mkdirSync(escapeTarget, { recursive: true });
  writeFileSync(join(escapeTarget, 'README.md'), 'secret\n');
}

describe('ClawHubService open 路径安全', () => {
  const service = new ClawHubService();

  beforeEach(() => {
    openedPaths.length = 0;
  });

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('正常 slug：打开 workDir/skills 内的目录', async () => {
    fixture();
    await expect(service.openSkillPath('legit-skill')).resolves.toBe(true);
    expect(openedPaths).toEqual([join(skillsRoot, 'legit-skill')]);
  });

  it('README 优先打开 SKILL.md 文档文件', async () => {
    fixture();
    await expect(service.openSkillReadme('legit-skill')).resolves.toBe(true);
    expect(openedPaths).toEqual([join(skillsRoot, 'legit-skill', 'SKILL.md')]);
  });

  it('manifest frontmatter name 解析不受影响', async () => {
    fixture();
    await expect(service.openSkillPath('Manifest Skill')).resolves.toBe(true);
    expect(openedPaths).toEqual([join(skillsRoot, 'renamed-dir')]);
  });

  it('「..」穿越：目标存在也拒绝打开（不逃逸 skills 根目录）', async () => {
    fixture();
    expect(existsSync(escapeTarget)).toBe(true);
    await expect(service.openSkillPath('../outside-secret')).rejects.toThrow('not found');
    await expect(service.openSkillReadme('../outside-secret')).rejects.toThrow('not found');
    expect(openedPaths).toEqual([]);
  });

  it('绝对路径注入：resolve 后脱离根目录 → 拒绝', async () => {
    fixture();
    await expect(service.openSkillPath(resolve(escapeTarget))).rejects.toThrow('not found');
    expect(openedPaths).toEqual([]);
  });

  it('不存在的 slug：抛 Skill directory not found', async () => {
    fixture();
    await expect(service.openSkillPath('no-such-skill')).rejects.toThrow('not found');
    expect(openedPaths).toEqual([]);
  });
});
