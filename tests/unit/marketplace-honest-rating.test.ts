/**
 * tests/unit/marketplace-honest-rating.test.ts
 *
 * 市场模板信誉字段诚实化：
 * - IDENTITY.md 未声明 Rating 时 rating=0（「无评分」约定，不再 Math.random 伪造）、
 *   hiredCount=0；
 * - 声明了 Rating 的模板如实透传；
 * - 两次调用结果一致（无随机性）。
 *
 * getResourcesDir mock 到临时 fixture 目录，真实走文件解析链路。
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const resourcesDir = mkdtempSync(join(tmpdir(), 'marketplace-rating-'));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => resourcesDir, getAppPath: () => resourcesDir },
}));

vi.mock('../../electron/utils/paths', () => ({
  getResourcesDir: () => resourcesDir,
  getOpenClawConfigDir: () => join(resourcesDir, 'openclaw-config'),
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { listMarketplaceTemplates } = await import('../../electron/utils/openclaw-workspace');

function writeTemplate(id: string, identity: string) {
  const dir = join(resourcesDir, 'marketplace', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), identity);
}

describe('listMarketplaceTemplates 信誉字段诚实化', () => {
  afterAll(() => {
    rmSync(resourcesDir, { recursive: true, force: true });
  });

  it('未声明 Rating 的模板：rating=0、hiredCount=0（不伪造随机数）', async () => {
    writeTemplate(
      'tpl-no-rating',
      [
        '# Test Agent',
        '',
        '**Name:** 测试专员',
        '**Emoji:** 🧪',
        '**Vibe:** 严谨、务实',
        '**Role:** 测试工程师',
      ].join('\n'),
    );
    const templates = await listMarketplaceTemplates();
    const tpl = templates.find((t) => t.id === 'tpl-no-rating');
    expect(tpl).toBeDefined();
    expect(tpl!.rating).toBe(0);
    expect(tpl!.hiredCount).toBe(0);
  });

  it('声明 Rating 的模板：如实透传', async () => {
    writeTemplate(
      'tpl-rated',
      [
        '**Name:** 评分专家',
        '**Emoji:** ⭐',
        '**Vibe:** 可靠',
        '**Role:** 质量顾问',
        '**Rating:** 4.9',
      ].join('\n'),
    );
    const templates = await listMarketplaceTemplates();
    const tpl = templates.find((t) => t.id === 'tpl-rated');
    expect(tpl).toBeDefined();
    expect(tpl!.rating).toBe(4.9);
  });

  it('两次调用结果一致（无随机性）', async () => {
    const first = await listMarketplaceTemplates();
    const second = await listMarketplaceTemplates();
    expect(first.map((t) => [t.id, t.rating, t.hiredCount])).toEqual(
      second.map((t) => [t.id, t.rating, t.hiredCount]),
    );
  });
});
