/**
 * tests/unit/multiFileIssue.test.ts
 *
 * 多文件真实 issue 任务契约单测（借鉴 SWE-EVO）：
 * - estimateComplexity：文件数/测试数 → 难度分级
 * - validateMultiFileIssueSpec：必填校验
 * - isMultiFileIssue / difficultyLabel
 */
import { describe, it, expect } from 'vitest';
import {
  estimateComplexity,
  validateMultiFileIssueSpec,
  isMultiFileIssue,
  difficultyLabel,
  type MultiFileIssueSpec,
} from '@/engine/interview/multiFileIssue';

function makeSpec(over: Partial<MultiFileIssueSpec> = {}): MultiFileIssueSpec {
  return {
    id: 'iss-1',
    issueTitle: '登录失败时未清空 token',
    issueDescription: '用户登出后 token 仍缓存',
    repoContext: 'Python/Django/auth 模块',
    affectedFiles: ['auth/views.py', 'auth/services.py'],
    testFiles: ['tests/test_auth.py'],
    expectedTestCount: 4,
    ...over,
  };
}

describe('estimateComplexity', () => {
  it('单文件少测试 → medium', () => {
    const r = estimateComplexity(makeSpec({ affectedFiles: ['a.py'], expectedTestCount: 2 }));
    expect(r.fileSpread).toBe(1);
    expect(r.complexityScore).toBeLessThan(30);
    expect(r.difficulty).toBe('medium');
  });

  it('中等文件数 → hard', () => {
    const r = estimateComplexity(
      makeSpec({
        affectedFiles: ['a.py', 'b.py', 'c.py', 'd.py', 'e.py', 'f.py', 'g.py'],
        expectedTestCount: 10,
      }),
    );
    expect(r.fileSpread).toBe(7);
    // 7*4 + 10*0.5 = 28 + 5 = 33
    expect(r.complexityScore).toBeGreaterThanOrEqual(30);
    expect(r.difficulty).toBe('hard');
  });

  it('SWE-EVO 量级（21 文件/874 测试）→ very-hard + 满分', () => {
    const r = estimateComplexity(
      makeSpec({
        affectedFiles: Array.from({ length: 21 }, (_, i) => `f${i}.py`),
        expectedTestCount: 874,
      }),
    );
    expect(r.fileSpread).toBe(21);
    expect(r.complexityScore).toBe(100);
    expect(r.difficulty).toBe('very-hard');
  });

  it('公式：fileSpread*4 + testCount*0.5', () => {
    const r = estimateComplexity(
      makeSpec({ affectedFiles: ['a.py', 'b.py'], expectedTestCount: 10 }),
    );
    // 2*4 + 10*0.5 = 8 + 5 = 13
    expect(r.complexityScore).toBe(13);
  });
});

describe('validateMultiFileIssueSpec', () => {
  it('完整 spec → ok=true', () => {
    expect(validateMultiFileIssueSpec(makeSpec()).ok).toBe(true);
  });

  it('缺 id → ok=false', () => {
    const r = validateMultiFileIssueSpec(makeSpec({ id: '' }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((x) => /id/.test(x))).toBe(true);
  });

  it('空 affectedFiles → ok=false', () => {
    const r = validateMultiFileIssueSpec(makeSpec({ affectedFiles: [] }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((x) => /affectedFiles/.test(x))).toBe(true);
  });

  it('expectedTestCount < 1 → ok=false', () => {
    const r = validateMultiFileIssueSpec(makeSpec({ expectedTestCount: 0 }));
    expect(r.ok).toBe(false);
  });
});

describe('isMultiFileIssue / difficultyLabel', () => {
  it('多文件 → true', () => {
    expect(isMultiFileIssue(makeSpec({ affectedFiles: ['a', 'b'] }))).toBe(true);
  });

  it('单文件 → false', () => {
    expect(isMultiFileIssue(makeSpec({ affectedFiles: ['a'] }))).toBe(false);
  });

  it('难度标签', () => {
    expect(difficultyLabel('medium')).toBe('中等');
    expect(difficultyLabel('hard')).toBe('困难');
    expect(difficultyLabel('very-hard')).toBe('极难');
  });
});
