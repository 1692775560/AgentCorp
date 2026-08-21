/**
 * tests/unit/tool-policy-sync.test.ts
 *
 * syncToolPolicyToConfig（openclaw-auth.ts）单测：
 * - 写入顶层 tools.fs.workspaceOnly=true + tools.elevated.enabled=false
 *   （经 `openclaw config validate` 探针验证的受支持键；gateway.toolPolicy
 *   会让 Gateway exit 1，绝不能写）；
 * - 合并语义：用户已有的其他 tools.* 键与 config 其他段不被覆盖；
 * - 空配置从零创建也能写出。
 *
 * homedir mock 到临时目录（OPENCLAW_CONFIG_PATH 是模块加载期常量），
 * config-mutex 直通（并发语义另有其自身测试覆盖）。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const fakeHome = mkdtempSync(join(tmpdir(), 'tool-policy-sync-'));

vi.mock('os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('os')>();
  return { ...orig, homedir: () => fakeHome };
});

vi.mock('../../electron/utils/config-mutex', () => ({
  withConfigLock: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { syncToolPolicyToConfig } = await import('../../electron/utils/openclaw-auth');

const configPath = join(fakeHome, '.openclaw', 'openclaw.json');

function writeConfig(config: Record<string, unknown>) {
  mkdirSync(join(fakeHome, '.openclaw'), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

describe('syncToolPolicyToConfig', () => {
  beforeEach(() => {
    rmSync(join(fakeHome, '.openclaw'), { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('空配置 → 从零写出 tools.fs.workspaceOnly + tools.elevated.enabled=false', async () => {
    await syncToolPolicyToConfig();
    expect(existsSync(configPath)).toBe(true);
    const config = readConfig();
    const tools = config.tools as Record<string, unknown>;
    expect((tools.fs as Record<string, unknown>).workspaceOnly).toBe(true);
    expect((tools.elevated as Record<string, unknown>).enabled).toBe(false);
  });

  it('合并语义：已有 tools.* 键与 config 其他段保留', async () => {
    writeConfig({
      gateway: { mode: 'local', auth: { token: 't' } },
      tools: { loopDetection: { enabled: true }, fs: { extra: 'keep' } },
    });
    await syncToolPolicyToConfig();
    const config = readConfig();
    const tools = config.tools as Record<string, unknown>;
    // 新约束写入
    expect((tools.fs as Record<string, unknown>).workspaceOnly).toBe(true);
    expect((tools.elevated as Record<string, unknown>).enabled).toBe(false);
    // 既有键不丢
    expect((tools.loopDetection as Record<string, unknown>).enabled).toBe(true);
    expect((tools.fs as Record<string, unknown>).extra).toBe('keep');
    // gateway 段原样
    expect((config.gateway as Record<string, unknown>).mode).toBe('local');
  });

  it('绝不写 gateway.toolPolicy（该键会让 Gateway exit 1）', async () => {
    await syncToolPolicyToConfig();
    const config = readConfig();
    const gateway = (config.gateway ?? {}) as Record<string, unknown>;
    expect('toolPolicy' in gateway).toBe(false);
  });
});
