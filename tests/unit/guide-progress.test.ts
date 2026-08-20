/**
 * tests/unit/guide-progress.test.ts
 *
 * 新手引导「完成检测」纯逻辑（guideProgress.ts）的单元测试：
 *   - 每个步骤的完成判定（认识员工 / 组建团队 / 派团队任务 / 验收交付）；
 *   - countDoneGuideSteps / isGuideComplete 的聚合语义。
 */
import { describe, it, expect } from 'vitest';

import {
  GUIDE_STEPS,
  countDoneGuideSteps,
  isGuideComplete,
  isGuideStepDone,
  type GuideSnapshot,
} from '@/components/onboarding/guideProgress';

function makeSnapshot(overrides: Partial<GuideSnapshot> = {}): GuideSnapshot {
  return { agentCount: 0, teamCount: 0, tasks: [], ...overrides };
}

const soloTask = { isTeamTask: false, teamId: undefined, status: 'done' as const };
const teamTaskDoing = { isTeamTask: true, teamId: 'team-1', status: 'in-progress' as const };
const teamTaskDone = { isTeamTask: true, teamId: 'team-1', status: 'done' as const };

describe('guideProgress · 步骤完成检测', () => {
  it('步骤定义有序且每步都带跳转路由', () => {
    expect(GUIDE_STEPS.map((s) => s.id)).toEqual([
      'meetAgents',
      'buildTeam',
      'dispatchTask',
      'acceptDelivery',
    ]);
    for (const step of GUIDE_STEPS) {
      expect(step.route).toMatch(/^\//);
    }
  });

  it('空快照下所有步骤均未完成', () => {
    const snapshot = makeSnapshot();
    for (const step of GUIDE_STEPS) {
      expect(isGuideStepDone(step.id, snapshot)).toBe(false);
    }
    expect(countDoneGuideSteps(snapshot)).toBe(0);
    expect(isGuideComplete(snapshot)).toBe(false);
  });

  it('meetAgents：已有/已雇 agent 数 > 0 时完成', () => {
    expect(isGuideStepDone('meetAgents', makeSnapshot({ agentCount: 0 }))).toBe(false);
    expect(isGuideStepDone('meetAgents', makeSnapshot({ agentCount: 1 }))).toBe(true);
  });

  it('buildTeam：团队数 > 0 时完成', () => {
    expect(isGuideStepDone('buildTeam', makeSnapshot({ teamCount: 0 }))).toBe(false);
    expect(isGuideStepDone('buildTeam', makeSnapshot({ teamCount: 2 }))).toBe(true);
  });

  it('dispatchTask：存在团队任务时完成（isTeamTask 或 teamId 任一命中）', () => {
    expect(isGuideStepDone('dispatchTask', makeSnapshot({ tasks: [soloTask] }))).toBe(false);
    expect(isGuideStepDone('dispatchTask', makeSnapshot({ tasks: [teamTaskDoing] }))).toBe(true);
    // 兼容老数据：仅有 teamId 未落 isTeamTask 也算团队任务
    expect(
      isGuideStepDone('dispatchTask', makeSnapshot({ tasks: [{ ...teamTaskDoing, isTeamTask: false }] })),
    ).toBe(true);
  });

  it('acceptDelivery：团队任务进入 done 才完成（单 agent 任务 done 不算）', () => {
    expect(isGuideStepDone('acceptDelivery', makeSnapshot({ tasks: [soloTask] }))).toBe(false);
    expect(isGuideStepDone('acceptDelivery', makeSnapshot({ tasks: [teamTaskDoing] }))).toBe(false);
    expect(isGuideStepDone('acceptDelivery', makeSnapshot({ tasks: [teamTaskDone] }))).toBe(true);
  });

  it('聚合：完成数随快照推进，全绿时 isGuideComplete', () => {
    const partial = makeSnapshot({ agentCount: 3, teamCount: 1, tasks: [teamTaskDoing] });
    expect(countDoneGuideSteps(partial)).toBe(3);
    expect(isGuideComplete(partial)).toBe(false);

    const full = makeSnapshot({ agentCount: 3, teamCount: 1, tasks: [teamTaskDoing, teamTaskDone] });
    expect(countDoneGuideSteps(full)).toBe(4);
    expect(isGuideComplete(full)).toBe(true);
  });
});
