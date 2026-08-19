/**
 * src/engine/interview/multiTurnTask.ts
 * 多轮交互任务契约（借鉴 τ-bench：客服/零售多轮对话 + policy 约束）。
 *
 * 设计理念（见 benchmark-research-2026-08-19.md）：
 * AgentCorp 当前面试题是单轮作答，缺「多轮交互 + policy 遵守」维度。
 * 本模块定义多轮任务的契约骨架 + policy 遵守判定纯函数——
 * 不实现完整 mock user simulator（那是 runtime 工程），但搭好评测契约：
 *   - 任务场景（零售/航空/客服/通用）
 *   - policy 规则（agent 必须遵守的约束）
 *   - 模拟用户脚本（多轮对话流）
 *   - 成功判据（policy 全遵守 + 完成轮数 + 任务目标达成）
 *
 * 纯函数、零外部依赖、可单测。runtime 接线留下一轮。
 */
import type { JobType } from '@/types/evaluation';

/** 任务场景（与 τ-bench 的零售/航空/客服对齐） */
export type MultiTurnScenario = 'retail' | 'airline' | 'customer-service' | 'general';

/** Policy 规则：agent 必须遵守的约束 */
export interface PolicyRule {
  id: string;
  description: string;
  /** 违反检测关键词（命中即视为违反；真实场景需 LLM 判定，这里给纯函数兜底） */
  violationKeywords?: string[];
  /** 违反检测正则（更精确） */
  violationPattern?: string;
}

/** 模拟用户单轮行为 */
export interface MockUserTurn {
  turnIndex: number;
  userMessage: string;
  /** 期望 agent 在本轮的行为特征（供 trajectory 评分，可选） */
  expectedAgentBehavior?: string;
}

/** 多轮交互任务规约 */
export interface MultiTurnTaskSpec {
  id: string;
  title: string;
  jobType: JobType;
  scenario: MultiTurnScenario;
  taskDescription: string;
  policyRules: PolicyRule[];
  mockUserScript: MockUserTurn[];
  maxTurns: number;
  /** 成功判据（自然语言，供裁判评分） */
  successCriteria: string;
  /** 关联公开 benchmark（见 benchmarkRef.ts） */
  benchmarkRefId?: string;
}

/** 对话记录条目 */
export interface TranscriptTurn {
  role: 'agent' | 'user';
  content: string;
  turnIndex: number;
}

/** Policy 违反记录 */
export interface PolicyViolation {
  ruleId: string;
  ruleDescription: string;
  evidence: string;
  turnIndex: number;
}

/** Policy 遵守评估结果 */
export interface PolicyComplianceReport {
  violations: PolicyViolation[];
  totalRules: number;
  complianceRate: number; // 0–1，遵守的规则占比
  evaluatedTurns: number;
}

/**
 * 评估对话记录的 policy 遵守情况（纯函数）。
 *
 * 检测方式（简化版，纯函数兜底）：
 * - 关键词命中 → 违反；
 * - 正则命中 → 违反；
 * - 真实场景应接 LLM 判定（裁判评估 policy 语义违反），本函数做硬规则兜底。
 *
 * 一条规则在一轮命中即记一次违反；同一规则多轮命中只记首次（避免重复计数）。
 */
export function evaluatePolicyCompliance(
  transcript: TranscriptTurn[],
  rules: PolicyRule[],
): PolicyComplianceReport {
  const agentTurns = transcript.filter((t) => t.role === 'agent');
  const violations: PolicyViolation[] = [];
  const violatedRuleIds = new Set<string>();

  for (const rule of rules) {
    if (violatedRuleIds.has(rule.id)) continue;
    for (const turn of agentTurns) {
      const content = turn.content ?? '';
      let hit = false;
      if (rule.violationKeywords && rule.violationKeywords.length > 0) {
        const lower = content.toLowerCase();
        hit = rule.violationKeywords.some((kw) =>
          kw ? lower.includes(kw.toLowerCase()) : false,
        );
      }
      if (!hit && rule.violationPattern) {
        try {
          hit = new RegExp(rule.violationPattern, 'i').test(content);
        } catch {
          // 正则非法：跳过正则检测，不算违反
        }
      }
      if (hit) {
        violations.push({
          ruleId: rule.id,
          ruleDescription: rule.description,
          evidence: content.slice(0, 200),
          turnIndex: turn.turnIndex,
        });
        violatedRuleIds.add(rule.id);
        break;
      }
    }
  }

  const totalRules = rules.length;
  const complianceRate =
    totalRules > 0 ? (totalRules - violatedRuleIds.size) / totalRules : 1;

  return {
    violations,
    totalRules,
    complianceRate,
    evaluatedTurns: agentTurns.length,
  };
}

/** 多轮任务成功判定（纯函数）：policy 全遵守 + 完成足够轮数 + 轮数达标 */
export interface MultiTurnTaskOutcome {
  passed: boolean;
  compliance: PolicyComplianceReport;
  completedTurns: number;
  requiredTurns: number;
  reasons: string[];
}

export function evaluateMultiTurnTask(
  transcript: TranscriptTurn[],
  spec: MultiTurnTaskSpec,
): MultiTurnTaskOutcome {
  const compliance = evaluatePolicyCompliance(transcript, spec.policyRules);
  const completedTurns = transcript.filter((t) => t.role === 'agent').length;
  const reasons: string[] = [];

  let passed = true;
  if (compliance.violations.length > 0) {
    passed = false;
    reasons.push(
      `policy 违反 ${compliance.violations.length} 条：${compliance.violations
        .map((v) => v.ruleId)
        .join(', ')}`,
    );
  }
  if (completedTurns < spec.maxTurns) {
    passed = false;
    reasons.push(
      `轮数不足：完成 ${completedTurns}/${spec.maxTurns}`,
    );
  }
  if (compliance.complianceRate < 1) {
    passed = false;
    reasons.push(
      `policy 遵守率 ${compliance.complianceRate.toFixed(2)} < 1.0`,
    );
  }
  if (passed) reasons.push('policy 全遵守 + 轮数达标');

  return {
    passed,
    compliance,
    completedTurns,
    requiredTurns: spec.maxTurns,
    reasons,
  };
}
