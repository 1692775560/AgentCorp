/**
 * src/types/lifecycle.ts
 * Agent 生命周期状态机（形式化，替代 AgentCorp 缺失的 AgentLifecycleStatus 类型）。
 *
 * 唯一真相 = 小写 AgentLifecycleStatus（onboarding/active/training/maintenance/retired）。
 * 评估层的大写 LifecycleState 仅作内部别名（定义见 src/types/evaluation.ts），
 * 二者经 LIFECYCLE_TO_STATE / STATE_TO_LIFECYCLE 对齐，避免双源（架构 §5 / §8）。
 *
 * 软退休约定：verdict FIRED → retired；MVP / OBSERVE → active（可经 Unretire 回 maintenance，不物理删除）。
 */

import type { LifecycleState, Verdict } from './evaluation';

/** 运行时真相：小写生命周期状态（AgentCorp 命名约定） */
export type AgentLifecycleStatus =
  | 'onboarding'
  | 'active'
  | 'training'
  | 'maintenance'
  | 'retired';

/** 全部小写状态（用于枚举展示 / 校验） */
export const AGENT_LIFECYCLE_STATUSES: readonly AgentLifecycleStatus[] = [
  'onboarding',
  'active',
  'training',
  'maintenance',
  'retired',
];

/**
 * 状态迁移表：每个状态允许到达的目标集合。
 * - 同态（from === to）始终允许（保持现状）。
 * - 软退休（retired）可经 maintenance 回流转岗，不物理删除。
 */
const LIFECYCLE_TRANSITIONS: Record<AgentLifecycleStatus, readonly AgentLifecycleStatus[]> = {
  onboarding: ['onboarding', 'active', 'training', 'retired'],
  active: ['active', 'training', 'maintenance', 'retired'],
  training: ['training', 'active', 'maintenance', 'retired'],
  maintenance: ['maintenance', 'active', 'training', 'retired'],
  retired: ['retired', 'maintenance'],
};

/**
 * 判断从 `from` 到 `to` 的状态迁移是否被允许。
 * 同态（from === to）恒为 true；其余查迁移表。
 */
export function canTransition(
  from: AgentLifecycleStatus,
  to: AgentLifecycleStatus,
): boolean {
  if (from === to) return true;
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** 小写生命周期 → 评估层大写别名 */
export const LIFECYCLE_TO_STATE: Record<AgentLifecycleStatus, LifecycleState> = {
  onboarding: 'ONBOARDING',
  active: 'ACTIVE',
  training: 'TRAINING',
  maintenance: 'MAINTENANCE',
  retired: 'RETIRED',
};

/** 评估层大写别名 → 小写生命周期（唯一真相） */
export const STATE_TO_LIFECYCLE: Record<LifecycleState, AgentLifecycleStatus> = {
  ONBOARDING: 'onboarding',
  ACTIVE: 'active',
  TRAINING: 'training',
  MAINTENANCE: 'maintenance',
  RETIRED: 'retired',
};

/**
 * 评估宣判 → 小写生命周期（软退休 / 入职通过）。
 * FIRED → retired；MVP / OBSERVE → active（架构 §8）。
 */
export function verdictToLifecycleStatus(verdict: Verdict): AgentLifecycleStatus {
  return verdict === 'FIRED' ? 'retired' : 'active';
}

/**
 * 评估宣判 → 大写别名（直接写入 EvaluationProfile.lifecycle）。
 */
export function verdictToLifecycleState(verdict: Verdict): LifecycleState {
  return LIFECYCLE_TO_STATE[verdictToLifecycleStatus(verdict)];
}

// 便于从 lifecycle 模块直接取到大写别名（与 evaluation.ts 同源）。
export type { LifecycleState } from './evaluation';
