/**
 * tests/unit/github-import.test.ts
 *
 * GitHub 一键导入的输入侧安全加固与映射约束。
 *
 * 这条链路是唯一一处「用户输入 → 主进程出网」的路径，因此第一道闸门必须自己写死：
 * 输入先解析成 {owner, repo}，再由我们拼 URL，绝不把用户字符串当 URL 直接 fetch。
 *
 * 另一组用例守的是产品立场：**导入不产生任何能力分**。
 * star 数只回答「还有人维护吗」，回答不了「能不能替你干活」——
 * 后者只能靠 S1/S2 实测。一旦允许 star 折算成初始分，
 * 「新发布的 agent 天然吃亏」这个我们要解决的问题就会原样回来。
 */
import { describe, expect, it } from 'vitest';

import {
  GithubImportError,
  daysSince,
  inferJobType,
  mapRepoToCandidate,
  parseRepoRef,
  sanitizeText,
} from '@electron/utils/github-import';

describe('parseRepoRef · 输入侧加固', () => {
  it('接受完整 URL / 裸域名 / owser-repo 三种写法', () => {
    expect(parseRepoRef('https://github.com/openai/openai-python')).toEqual({
      owner: 'openai',
      repo: 'openai-python',
    });
    expect(parseRepoRef('github.com/openai/openai-python')).toEqual({
      owner: 'openai',
      repo: 'openai-python',
    });
    expect(parseRepoRef('openai/openai-python')).toEqual({
      owner: 'openai',
      repo: 'openai-python',
    });
  });

  it('容忍 .git 后缀、子路径与首尾空白', () => {
    expect(parseRepoRef('  https://github.com/a-b/c.d.git  ')).toEqual({ owner: 'a-b', repo: 'c.d' });
    expect(parseRepoRef('https://github.com/owner/repo/tree/main/src')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('拒绝非 github.com 主机（SSRF 第一道闸门）', () => {
    for (const evil of [
      'https://evil.com/owner/repo',
      'https://github.com.evil.com/owner/repo',
      'https://127.0.0.1/owner/repo',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/owner/repo',
    ]) {
      expect(() => parseRepoRef(evil)).toThrow(GithubImportError);
    }
  });

  it('拒绝非 http(s) 协议', () => {
    for (const evil of ['file:///etc/passwd', 'ftp://github.com/a/b', 'javascript:alert(1)']) {
      expect(() => parseRepoRef(evil)).toThrow(GithubImportError);
    }
  });

  it('拒绝路径穿越与非法字符（避免拼出越权 API 路径）', () => {
    for (const evil of [
      '../../etc/passwd',
      'owner/../../users/victim',
      'owner/repo?ref=x',
      'owner/re po',
      'owner/repo#frag',
      'own er/repo',
    ]) {
      expect(() => parseRepoRef(evil)).toThrow(GithubImportError);
    }
  });

  it('拒绝空输入与缺段输入', () => {
    for (const bad of ['', '   ', 'owner', 'https://github.com/owner']) {
      expect(() => parseRepoRef(bad)).toThrow(GithubImportError);
    }
  });

  it('超长 owner/repo 被拒（防止拼出异常长的请求）', () => {
    expect(() => parseRepoRef(`${'a'.repeat(200)}/repo`)).toThrow(GithubImportError);
  });
});

describe('sanitizeText · 输出侧清洗', () => {
  it('剥离控制字符并压缩空白', () => {
    expect(sanitizeText('a\u0000b\nc\t d', 100)).toBe('a b c d');
  });

  it('按上限截断，非字符串返回空串', () => {
    expect(sanitizeText('x'.repeat(50), 10)).toHaveLength(10);
    expect(sanitizeText(null, 10)).toBe('');
    expect(sanitizeText({ evil: true }, 10)).toBe('');
  });
});

describe('inferJobType · 判断不了就不猜', () => {
  it('按主语言与 topics 推断工种', () => {
    expect(inferJobType('Python', [])).toBe('code');
    expect(inferJobType(null, ['text-to-image'])).toBe('image');
    expect(inferJobType(null, ['copywriting'])).toBe('text');
  });

  it('无法判断时返回 null，而不是随便塞一个默认工种', () => {
    expect(inferJobType(null, [])).toBeNull();
    expect(inferJobType('Shell', ['misc'])).toBeNull();
  });
});

describe('mapRepoToCandidate · 导入不产生能力分', () => {
  const raw = {
    name: 'awesome-agent',
    description: '一个开源 agent',
    stargazers_count: 12345,
    forks_count: 678,
    open_issues_count: 9,
    license: { spdx_id: 'MIT' },
    default_branch: 'main',
    pushed_at: '2026-08-01T00:00:00Z',
    language: 'Python',
    topics: ['agent', 'llm'],
    owner: { login: 'someone', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
  };
  const ref = { owner: 'someone', repo: 'awesome-agent' };

  it('rating 恒为 null，hiredCount 恒为 0（未实测就没有分）', () => {
    const c = mapRepoToCandidate(raw, ref);
    expect(c.rating).toBeNull();
    expect(c.hiredCount).toBe(0);
  });

  it('star 数只进 meta 供展示，不出现在任何评分字段', () => {
    const c = mapRepoToCandidate(raw, ref);
    expect(c.githubMeta.stars).toBe(12345);
    // 候选卡顶层不得出现任何由 star 折算的数值字段
    const serialized = JSON.stringify({ ...c, githubMeta: undefined });
    expect(serialized).not.toContain('12345');
  });

  it('id 稳定且小写，便于重复导入时幂等覆盖', () => {
    expect(mapRepoToCandidate(raw, ref).id).toBe('gh:someone/awesome-agent');
    expect(mapRepoToCandidate({ ...raw, name: 'Awesome-Agent' }, ref).id).toBe(
      'gh:someone/awesome-agent',
    );
  });

  it('缺失字段有安全兜底，不产生 undefined 文案', () => {
    const c = mapRepoToCandidate({}, { owner: 'o', repo: 'r' });
    expect(c.name).toBe('r');
    expect(c.description).toContain('未填写简介');
    expect(c.githubMeta.license).toBe('未声明');
    expect(c.githubMeta.branch).toBe('main');
    expect(c.tags).toEqual(['未标注']);
  });

  it('NOASSERTION 协议归一为「未声明」（合规审查时不能被误读为有许可）', () => {
    const c = mapRepoToCandidate({ ...raw, license: { spdx_id: 'NOASSERTION' } }, ref);
    expect(c.githubMeta.license).toBe('未声明');
  });

  it('恶意描述里的控制字符被清洗', () => {
    const c = mapRepoToCandidate({ ...raw, description: 'evil\u0000\n\ndesc' }, ref);
    expect(c.description).toBe('evil desc');
  });

  it('活跃度按天数如实呈现（事实，不是分数）', () => {
    const now = Date.parse('2026-08-18T00:00:00Z');
    const c = mapRepoToCandidate(raw, ref, now);
    expect(c.githubMeta.daysSincePush).toBe(17);
  });
});

describe('daysSince', () => {
  it('无效或缺失时间戳返回 null，不返回 0（0 会被误读为「今天刚提交」）', () => {
    expect(daysSince(undefined)).toBeNull();
    expect(daysSince('not-a-date')).toBeNull();
  });
});
