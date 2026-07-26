/**
 * src/engine/strategyEngine.ts
 * 职场生命周期状态机（评估设计 §4）：把真实 HR 机制映射到 agent 生命周期。
 *
 * 设计约束（阶段 A）：
 * - 纯函数、无副作用、可单测。
 * - 持有迁移规则表（含守卫 guard）+ 触发事件类型。
 * - transition() 输入「当前态 + 触发 + 上下文」，输出目标态 + 产生的 LifecycleEvent。
 */
import {
  LifecycleState,
  LifecycleTrigger,
  LifecycleEvent,
} from "../types/evaluation";

/** 状态机迁移上下文（由编排层在触发时注入） */
export interface StrategyContext {
  agentId: string;
  rank: number; // 擂台名次（1=榜首）
  totalCandidates: number;
  roi_norm: number; // ROI 群体 z-score
  consecutiveBottom: number; // 连续末位次数（>=2 触发淘汰）
  reEvalScore?: number; // PIP 再评估分
  evalScore?: number; // 入职评估分
  ts?: string; // 事件时间戳（演示复现可传固定值）
}

/** 单条迁移规则 */
interface TransitionRule {
  trigger: LifecycleTrigger;
  guard: (ctx: StrategyContext) => boolean;
  to: LifecycleState;
  reason: (ctx: StrategyContext) => string;
}

/**
 * 状态转换函数表（评估设计 §4.2 / playbook §2.5.1）。
 * 每条规则带守卫条件与可读原因，组件可直接渲染 reason 文本。
 */
export const TRANSITIONS: Record<LifecycleState, TransitionRule[]> = {
  ONBOARDING: [
    {
      trigger: "probation_pass",
      guard: (c) => (c.evalScore ?? 0) >= 3.0,
      to: "ACTIVE",
      reason: () => "试用期评估通过，正式入职",
    },
    {
      trigger: "probation_fail",
      guard: (c) => (c.evalScore ?? 0) < 3.0,
      to: "RETIRED",
      reason: () => "入职评估未达标，不予录用",
    },
  ],
  ACTIVE: [
    {
      trigger: "monthly_arena",
      guard: (c) => c.rank === 1,
      to: "ACTIVE",
      reason: () => "月度擂台榜首，授予本月 MVP",
    },
    {
      trigger: "monthly_arena",
      guard: (c) => c.rank === c.totalCandidates && c.consecutiveBottom < 1,
      to: "TRAINING",
      reason: (c) =>
        `月度擂台末位（第 ${c.rank}/${c.totalCandidates}），进入 PIP 培训`,
    },
    {
      trigger: "roi_drop",
      guard: (c) => c.roi_norm < -1.5,
      to: "MAINTENANCE",
      reason: () => "ROI 骤降（z-score < -1.5），建议启用备用替补",
    },
    {
      trigger: "manual",
      guard: () => true,
      to: "RETIRED",
      reason: () => "人工执行一键 fire（You are fired）",
    },
  ],
  TRAINING: [
    {
      trigger: "pip_pass",
      guard: (c) => (c.reEvalScore ?? 0) >= 3.0,
      to: "ACTIVE",
      reason: (c) =>
        `PIP 再评估通过（${c.reEvalScore?.toFixed(1)}），回岗`,
    },
    {
      trigger: "pip_fail",
      guard: () => true,
      to: "RETIRED",
      reason: () => "PIP 再评估未通过，淘汰",
    },
    {
      trigger: "monthly_arena",
      guard: (c) => c.consecutiveBottom >= 2,
      to: "RETIRED",
      reason: () => "连续两期月度末位，确认淘汰",
    },
    {
      // 一键 fire：与 ACTIVE / MAINTENANCE 一致，培训中也可直接淘汰
      // （修复：原缺此规则导致 monthly_arena 后处于 TRAINING 的候选无法被 fire）
      trigger: "manual",
      guard: () => true,
      to: "RETIRED",
      reason: () => "人工执行一键 fire（You are fired）",
    },
  ],
  MAINTENANCE: [
    {
      trigger: "replaced",
      guard: () => true,
      to: "ACTIVE",
      reason: () => "备用员工顶替后 ROI 恢复，回岗",
    },
    {
      trigger: "manual",
      guard: () => true,
      to: "RETIRED",
      reason: () => "确认裁员",
    },
  ],
  RETIRED: [],
};

/**
 * 状态迁移：找到匹配 trigger 且 guard 通过的规则。
 * 无合法迁移时保持原态并返回 event=null（调用方据此判断是否需要落库）。
 */
export function transition(
  state: LifecycleState,
  trigger: LifecycleTrigger,
  ctx: StrategyContext,
): { to: LifecycleState; event: LifecycleEvent | null } {
  const rules = TRANSITIONS[state] ?? [];
  const rule = rules.find((r) => r.trigger === trigger && r.guard(ctx));
  if (!rule) return { to: state, event: null };

  const to = rule.to;
  const event: LifecycleEvent = {
    agentId: ctx.agentId,
    from: state,
    to,
    reason: rule.reason(ctx),
    trigger,
    ts: ctx.ts ?? new Date().toISOString(),
  };
  return { to, event };
}

/** 五态展示顺序（组件渲染状态机视图用） */
export const LIFECYCLE_ORDER: LifecycleState[] = [
  "ONBOARDING",
  "ACTIVE",
  "TRAINING",
  "MAINTENANCE",
  "RETIRED",
];

/** 五态中文标签 */
export const LIFECYCLE_LABELS: Record<LifecycleState, string> = {
  ONBOARDING: "入职",
  ACTIVE: "在岗",
  TRAINING: "培训(PIP)",
  MAINTENANCE: "替补",
  RETIRED: "已淘汰",
};
