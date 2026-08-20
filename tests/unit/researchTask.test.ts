/**
 * tests/unit/researchTask.test.ts
 *
 * 研究综合任务契约单测（借鉴 GAIA）：
 * - estimateResearchComplexity：步骤/搜索步/难度权重 → 复杂度分
 * - validateResearchTaskSpec：必填校验
 * - evaluateSourceCoverage：来源覆盖
 * - researchDifficultyLabel
 */
import { describe, it, expect } from 'vitest';
import {
  estimateResearchComplexity,
  validateResearchTaskSpec,
  evaluateSourceCoverage,
  researchDifficultyLabel,
  type ResearchTaskSpec,
} from '@/engine/interview/researchTask';

function makeSpec(over: Partial<ResearchTaskSpec> = {}): ResearchTaskSpec {
  return {
    id: 'r-1',
    title: '市场调研',
    question: '2026 年 AI agent 评测工具有哪些主流方案？',
    difficulty: 'level2',
    steps: [
      { description: '搜索方案', requiresWebSearch: true, expectedSources: 3 },
      { description: '对比维度', requiresWebSearch: false },
      { description: '综合输出报告', requiresWebSearch: false },
    ],
    outputFormat: 'report',
    successCriteria: '覆盖 3 个来源 + 给出对比维度',
    ...over,
  };
}

describe('estimateResearchComplexity', () => {
  it('level1 + 少步 → 低分', () => {
    const r = estimateResearchComplexity(
      makeSpec({ difficulty: 'level1', steps: [{ description: 'x', requiresWebSearch: false }] }),
    );
    expect(r).toBeLessThan(30);
  });

  it('level3 + 多搜索步 → 高分', () => {
    const r = estimateResearchComplexity(
      makeSpec({
        difficulty: 'level3',
        steps: [
          { description: 's1', requiresWebSearch: true },
          { description: 's2', requiresWebSearch: true },
          { description: 's3', requiresWebSearch: true },
          { description: 's4', requiresWebSearch: true },
        ],
      }),
    );
    // 4*3 + 4*5 + 50 = 12+20+50 = 82
    expect(r).toBe(82);
  });

  it('公式：steps*3 + webSearch*5 + difficultyWeight', () => {
    const r = estimateResearchComplexity(makeSpec());
    // 3 步 *3 = 9；1 搜索步 *5 = 5；level2=30；总 44
    expect(r).toBe(44);
  });

  it('夹取到 [0,100]', () => {
    const r = estimateResearchComplexity(
      makeSpec({
        difficulty: 'level3',
        steps: Array.from({ length: 50 }, () => ({ description: 'x', requiresWebSearch: true })),
      }),
    );
    expect(r).toBe(100);
  });
});

describe('validateResearchTaskSpec', () => {
  it('完整 → ok=true', () => {
    expect(validateResearchTaskSpec(makeSpec()).ok).toBe(true);
  });
  it('非法 difficulty → ok=false', () => {
    const r = validateResearchTaskSpec(
      makeSpec({ difficulty: 'level9' as never }),
    );
    expect(r.ok).toBe(false);
  });
  it('空 steps → ok=false', () => {
    const r = validateResearchTaskSpec(makeSpec({ steps: [] }));
    expect(r.ok).toBe(false);
  });
  it('非法 outputFormat → ok=false', () => {
    const r = validateResearchTaskSpec(
      makeSpec({ outputFormat: 'pdf' as never }),
    );
    expect(r.ok).toBe(false);
  });
});

describe('evaluateSourceCoverage', () => {
  it('达到期望 → covered=true', () => {
    const r = evaluateSourceCoverage(3, makeSpec());
    expect(r.covered).toBe(true);
    expect(r.expected).toBe(3);
    expect(r.deficit).toBe(0);
  });
  it('不足 → covered=false + deficit', () => {
    const r = evaluateSourceCoverage(1, makeSpec());
    expect(r.covered).toBe(false);
    expect(r.deficit).toBe(2);
  });
  it('超出 → covered=true', () => {
    const r = evaluateSourceCoverage(10, makeSpec());
    expect(r.covered).toBe(true);
  });
});

describe('researchDifficultyLabel', () => {
  it('三级标签', () => {
    expect(researchDifficultyLabel('level1')).toBe('入门');
    expect(researchDifficultyLabel('level2')).toBe('进阶');
    expect(researchDifficultyLabel('level3')).toBe('挑战');
  });
});
