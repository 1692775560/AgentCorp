/**
 * tests/unit/benchmarkRef.test.ts
 *
 * 公开 benchmark 参照知识库 + 任务类型分类单测：
 * - classifyTaskType：显式标志 / 文本启发式 / 工种兜底 / unknown
 * - benchmarkRefForTaskType：映射 + 未匹配返回 null
 * - taskTypeLabel / listBenchmarkRefs
 */
import { describe, it, expect } from 'vitest';

import {
  classifyTaskType,
  benchmarkRefForTaskType,
  taskTypeLabel,
  listBenchmarkRefs,
  BENCHMARK_REFS,
} from '@/engine/interview/benchmarkRef';

describe('classifyTaskType', () => {
  it('显式标志：isIssueFix + multiFile → code-multi-file', () => {
    expect(
      classifyTaskType({ isIssueFix: true, multiFile: true, jobType: 'code' }),
    ).toBe('code-multi-file');
  });

  it('显式标志：isIssueFix 单文件 → code-issue-fix', () => {
    expect(classifyTaskType({ isIssueFix: true, jobType: 'code' })).toBe(
      'code-issue-fix',
    );
  });

  it('显式标志：multiTurn + hasPolicy → multi-turn-policy', () => {
    expect(classifyTaskType({ multiTurn: true, hasPolicy: true })).toBe(
      'multi-turn-policy',
    );
  });

  it('显式标志：requiresWebSearch → research-synthesis', () => {
    expect(classifyTaskType({ requiresWebSearch: true })).toBe(
      'research-synthesis',
    );
  });

  it('显式标志：isGuiOperation → gui-operation', () => {
    expect(classifyTaskType({ isGuiOperation: true })).toBe('gui-operation');
  });

  it('显式标志：isEnterpriseWorkflow → enterprise-workflow', () => {
    expect(classifyTaskType({ isEnterpriseWorkflow: true })).toBe(
      'enterprise-workflow',
    );
  });

  it('显式标志：isCommandLine → command-line', () => {
    expect(classifyTaskType({ isCommandLine: true })).toBe('command-line');
  });

  it('文本启发式：含 issue/bug fix → code-issue-fix', () => {
    expect(
      classifyTaskType({ taskText: '修复这个 GitHub issue 里的 bug', jobType: 'code' }),
    ).toBe('code-issue-fix');
  });

  it('文本启发式：含 多轮/客服/客户沟通 + policy → multi-turn-policy', () => {
    expect(
      classifyTaskType({
        taskText: '多轮客户沟通，遵守客服 policy 合规约束',
        jobType: 'text',
      }),
    ).toBe('multi-turn-policy');
  });

  it('文本启发式：含 调研/研究/search → research-synthesis', () => {
    expect(
      classifyTaskType({ taskText: '调研市场并综合分析', jobType: 'text' }),
    ).toBe('research-synthesis');
  });

  it('文本启发式：含 多文件/重构 → code-multi-file', () => {
    expect(
      classifyTaskType({
        taskText: '这个重构涉及多文件跨模块',
        isIssueFix: true,
        jobType: 'code',
      }),
    ).toBe('code-multi-file');
  });

  it('工种兜底：code/text/image 无其他标志 → single-turn', () => {
    expect(classifyTaskType({ jobType: 'code' })).toBe('single-turn');
    expect(classifyTaskType({ jobType: 'text' })).toBe('single-turn');
    expect(classifyTaskType({ jobType: 'image' })).toBe('single-turn');
  });

  it('无任何信息 → unknown', () => {
    expect(classifyTaskType({})).toBe('unknown');
    expect(classifyTaskType({})).toBe('unknown');
  });

  it('优先级：enterprise-workflow > gui-operation > multi-turn-policy', () => {
    // 多个标志同时存在时，更具体的优先
    expect(
      classifyTaskType({
        isEnterpriseWorkflow: true,
        isGuiOperation: true,
        multiTurn: true,
        hasPolicy: true,
      }),
    ).toBe('enterprise-workflow');
  });
});

describe('benchmarkRefForTaskType', () => {
  it('code-issue-fix → SWE-bench Verified', () => {
    const ref = benchmarkRefForTaskType('code-issue-fix');
    expect(ref?.id).toBe('swe-bench-verified');
    expect(ref?.name).toBe('SWE-bench Verified');
    expect(ref?.realWorldRelevance).toBe(5);
  });

  it('multi-turn-policy → τ-bench', () => {
    const ref = benchmarkRefForTaskType('multi-turn-policy');
    expect(ref?.id).toBe('tau-bench');
  });

  it('research-synthesis → GAIA', () => {
    const ref = benchmarkRefForTaskType('research-synthesis');
    expect(ref?.id).toBe('gaia');
  });

  it('code-multi-file → SWE-EVO', () => {
    const ref = benchmarkRefForTaskType('code-multi-file');
    expect(ref?.id).toBe('swe-evo');
  });

  it('gui-operation → OSWorld', () => {
    const ref = benchmarkRefForTaskType('gui-operation');
    expect(ref?.id).toBe('osworld');
  });

  it('enterprise-workflow → WorkArena', () => {
    const ref = benchmarkRefForTaskType('enterprise-workflow');
    expect(ref?.id).toBe('workarena');
  });

  it('single-turn → 无公开对照（返回 null，诚实降级）', () => {
    // single-turn 是 AgentCorp 现有 12 题模式，不直接对照单一公开 benchmark
    expect(benchmarkRefForTaskType('single-turn')).toBeNull();
  });

  it('unknown → null', () => {
    expect(benchmarkRefForTaskType('unknown')).toBeNull();
  });
});

describe('taskTypeLabel', () => {
  it('每个 TaskType 都有可读标签', () => {
    expect(taskTypeLabel('single-turn')).toBe('单轮作答');
    expect(taskTypeLabel('code-issue-fix')).toBe('真实 issue 修复');
    expect(taskTypeLabel('multi-turn-policy')).toBe('多轮交互 + 约束');
    expect(taskTypeLabel('research-synthesis')).toBe('研究综合');
    expect(taskTypeLabel('unknown')).toBe('未分类');
  });
});

describe('listBenchmarkRefs', () => {
  it('返回全部 8 个参照，按真实职场相关度降序', () => {
    const list = listBenchmarkRefs();
    expect(list.length).toBe(BENCHMARK_REFS.length);
    expect(list.length).toBeGreaterThanOrEqual(8);
    // 相关度 5 的在前
    expect(list[0].realWorldRelevance).toBeGreaterThanOrEqual(list[list.length - 1].realWorldRelevance);
  });

  it('SWE-bench Verified / SWE-EVO / τ-bench / WorkArena 都是相关度 5', () => {
    const list = listBenchmarkRefs();
    const top5 = list.filter((b) => b.realWorldRelevance === 5).map((b) => b.id);
    expect(top5).toContain('swe-bench-verified');
    expect(top5).toContain('swe-evo');
    expect(top5).toContain('tau-bench');
    expect(top5).toContain('workarena');
  });
});
