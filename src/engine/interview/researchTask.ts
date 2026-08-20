/**
 * src/engine/interview/researchTask.ts
 * 研究综合任务契约（借鉴 GAIA：多步 web 研究 + 综合）。
 *
 * 设计理念（见 benchmark-research-2026-08-19.md）：
 * GAIA 是通用 assistant 标杆，需多步工具 + web 研究，三级难度。
 * AgentCorp 当前缺「研究综合」维度。本模块定义研究任务契约骨架——
 * 不实现 web search runtime（那是工具系统扩展），但搭好评测契约：
 *   - 研究步骤（每步标注是否需 web 搜索）
 *   - 难度分级（GAIA 三级）
 *   - 输出格式（exact-match / short-answer / report）
 *   - 成功判据
 *
 * 纯函数、零外部依赖、可单测。web search skill 接线留下一轮。
 */

/** GAIA 三级难度 */
export type ResearchDifficulty = 'level1' | 'level2' | 'level3';

/** 输出格式（与 GAIA exact-match 对齐 + 扩展） */
export type ResearchOutputFormat = 'exact-match' | 'short-answer' | 'report';

/** 研究步骤 */
export interface ResearchStep {
  description: string;
  /** 本步是否需要 web 搜索 */
  requiresWebSearch: boolean;
  /** 期望引用的来源数（report 格式用） */
  expectedSources?: number;
  /** 期望产出（供裁判评分） */
  expectedOutput?: string;
}

/** 研究综合任务规约 */
export interface ResearchTaskSpec {
  id: string;
  title: string;
  /** 研究问题（GAIA 风格的自然语言问题） */
  question: string;
  difficulty: ResearchDifficulty;
  steps: ResearchStep[];
  outputFormat: ResearchOutputFormat;
  /** 成功判据（自然语言，供裁判评分） */
  successCriteria: string;
  /** 关联公开 benchmark（见 benchmarkRef.ts） */
  benchmarkRefId?: string;
}

/**
 * 估算研究任务复杂度（纯函数）。
 *
 * 公式（启发式）：
 *   score = steps.length * 3 + webSearchSteps * 5 + difficultyWeight
 *   - 每步 +3；需 web 搜索的步额外 +5（搜索比推理贵）
 *   - 难度权重：level1=10, level2=30, level3=50
 *   - 复杂度 ∈ [0, 100]
 */
export function estimateResearchComplexity(spec: ResearchTaskSpec): number {
  const difficultyWeight =
    spec.difficulty === 'level3' ? 50 : spec.difficulty === 'level2' ? 30 : 10;
  const webSearchSteps = spec.steps.filter((s) => s.requiresWebSearch).length;
  const raw = spec.steps.length * 3 + webSearchSteps * 5 + difficultyWeight;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** 校验研究任务规约完整性（纯函数）。 */
export function validateResearchTaskSpec(
  spec: ResearchTaskSpec,
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!spec.id) issues.push('id is required');
  if (!spec.title) issues.push('title is required');
  if (!spec.question) issues.push('question is required');
  if (
    spec.difficulty !== 'level1' &&
    spec.difficulty !== 'level2' &&
    spec.difficulty !== 'level3'
  ) {
    issues.push('difficulty must be level1/level2/level3');
  }
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    issues.push('steps must be a non-empty array');
  }
  if (
    spec.outputFormat !== 'exact-match' &&
    spec.outputFormat !== 'short-answer' &&
    spec.outputFormat !== 'report'
  ) {
    issues.push('outputFormat must be exact-match/short-answer/report');
  }
  if (!spec.successCriteria) issues.push('successCriteria is required');
  return { ok: issues.length === 0, issues };
}

/** 评估研究产出是否达到期望来源数（report 格式用，纯函数）。 */
export function evaluateSourceCoverage(
  citedSources: number,
  spec: ResearchTaskSpec,
): { covered: boolean; cited: number; expected: number; deficit: number } {
  const expected = spec.steps.reduce(
    (sum, s) => sum + (s.expectedSources ?? 0),
    0,
  );
  const deficit = Math.max(0, expected - citedSources);
  return {
    covered: deficit === 0,
    cited: citedSources,
    expected,
    deficit,
  };
}

/** 难度可读标签（发布会口径）。 */
export function researchDifficultyLabel(d: ResearchDifficulty): string {
  switch (d) {
    case 'level1':
      return '入门';
    case 'level2':
      return '进阶';
    case 'level3':
      return '挑战';
    default:
      return String(d);
  }
}
