/**
 * src/components/onboarding/guideProgress.ts
 * 新手引导的「完成检测」纯逻辑：给定一份业务快照，判定每个引导步骤是否已完成。
 *
 * 抽成纯函数便于单测；FirstRunGuide 组件负责从各 store 组装快照并订阅变化，
 * 步骤满足条件时自动打勾（不需要用户手动确认）。
 */
import type { KanbanTask } from '@/types/task';

export type GuideStepId = 'meetAgents' | 'buildTeam' | 'dispatchTask' | 'acceptDelivery';

export interface GuideStepDef {
  id: GuideStepId;
  /** 「去做」按钮跳转的路由 */
  route: string;
}

/** 引导步骤（顺序即展示顺序）。 */
export const GUIDE_STEPS: readonly GuideStepDef[] = [
  { id: 'meetAgents', route: '/marketplace' },
  { id: 'buildTeam', route: '/team-builder' },
  { id: 'dispatchTask', route: '/office' },
  { id: 'acceptDelivery', route: '/office' },
];

/** 引导进度判定所需的业务快照（由组件从各 store 组装）。 */
export interface GuideSnapshot {
  /** 已有/已雇佣的 agent 数 */
  agentCount: number;
  /** 已组建的团队数 */
  teamCount: number;
  /** 看板上的全部任务（用于判定是否派过团队任务、是否有已验收的团队交付） */
  tasks: ReadonlyArray<Pick<KanbanTask, 'isTeamTask' | 'teamId' | 'status'>>;
}

/** 任务是否属于团队任务（后端落 isTeamTask = Boolean(teamId)，两者取并集兜底）。 */
function isTeamTask(task: Pick<KanbanTask, 'isTeamTask' | 'teamId'>): boolean {
  return task.isTeamTask || Boolean(task.teamId);
}

export function isGuideStepDone(stepId: GuideStepId, snapshot: GuideSnapshot): boolean {
  switch (stepId) {
    case 'meetAgents':
      return snapshot.agentCount > 0;
    case 'buildTeam':
      return snapshot.teamCount > 0;
    case 'dispatchTask':
      return snapshot.tasks.some(isTeamTask);
    case 'acceptDelivery':
      return snapshot.tasks.some((task) => isTeamTask(task) && task.status === 'done');
  }
}

export function countDoneGuideSteps(snapshot: GuideSnapshot): number {
  return GUIDE_STEPS.filter((step) => isGuideStepDone(step.id, snapshot)).length;
}

export function isGuideComplete(snapshot: GuideSnapshot): boolean {
  return GUIDE_STEPS.every((step) => isGuideStepDone(step.id, snapshot));
}
