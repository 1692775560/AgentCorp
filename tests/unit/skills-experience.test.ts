/**
 * 经验沉淀 Store——boss_review 决策即沉淀，下一次闭环注入复用。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveRule,
  loadRules,
  latestRule,
  clearRules,
  createMemoryPersister,
  setExperiencePersister,
} from '@/demo/skills/experienceStore';
import { runSkill } from '@/demo/skills/registry';
import { registerBuiltinSkills, type BossReviewOutput } from '@/demo/skills/handlers';
import { runClosedLoop } from '@/demo/closedLoop';
import { mockJudge } from '@/demo/mockJudge';
import { passK } from '@/engine/evaluation/passK';
import { auditJudgeBias } from '@/services/judgeClient';
import { aggregateRadars } from '@/services/judgeEnsemble';
import type { RadarScore } from '@/types/evaluation';

registerBuiltinSkills();

const radar = (v: number): RadarScore => ({
  task: v,
  quality: v,
  comm: v,
  creativity: v,
  reliability: v,
  cost: v,
});

const LOOP_REQ = {
  requirement: '招聘一名能独立承担前端组件库开发的 Agent 工程师。',
  candidateId: 'fe-agent-07',
  candidateName: 'FrontendAgent-07',
  candidatePersona: '前端组件库 Agent。',
  transcript: '面试官：如何拆分大型表单？\n候选：先复述需求，再按职责拆分。',
  k: 3,
  threshold: 3.5,
};

beforeEach(() => {
  setExperiencePersister(createMemoryPersister());
  clearRules();
});

describe('skills/experienceStore', () => {
  it('saveRule/loadRules/latestRule 基本存取语义（同候选隔离，无跨候选兜底）', () => {
    expect(latestRule()).toBeNull();
    const radars = [radar(4.5), radar(4.6)];
    saveRule('c1', {
      weakestDim: 'cost',
      strongestDim: 'task',
      trainingFocus: 't',
      reuseNote: 'r',
      rule: '规则1',
      source: 'boss_review',
      ts: Date.now(),
    });
    expect(loadRules('c1')).toHaveLength(1);
    expect(latestRule('c1')?.weakestDim).toBe('cost');
    expect(latestRule('c2')).toBeNull(); // H3：不把 c1 的规则错配注入 c2
    expect(latestRule()?.rule).toBe('规则1'); // 无 candidateId 时才是全局最近
    expect(radars.length).toBe(2); // 无副作用
  });

  it('boss_review Skill 决策后自动写入经验 Store', async () => {
    const radars = [radar(4.5), radar(4.6), radar(4.4)];
    const res = await runSkill('boss_review', {
      evaluation: {
        passK: passK(radars, { k: 3 }),
        biasAudit: auditJudgeBias(radars),
        verdict: 'MVP',
        confidence: 0.9,
        meanRadar: aggregateRadars(radars),
      },
      candidateId: 'c1',
      candidateName: '候选一',
    });
    expect(res.ok).toBe(true);
    const stored = latestRule('c1');
    expect(stored).not.toBeNull();
    expect(stored!.source).toBe('boss_review');
    expect(stored!.weakestDim).toBe((res.data as BossReviewOutput).precipitatedRule.weakestDim);
  });

  it('两连跑：第二次闭环的 context 轨迹注入了第一次沉淀的规则', async () => {
    const first = await runClosedLoop({ ...LOOP_REQ, judge: mockJudge });
    expect(first.precipitatedRule.source).toBe('boss_review');

    const second = await runClosedLoop({ ...LOOP_REQ, judge: mockJudge });
    const contextStep = second.trace.find((t) => t.phase === 'context');
    const injected = (contextStep?.payload as { injectedRule?: { weakestDim: string; ts: number } })
      .injectedRule;
    // 第二次 run 注入了第一次沉淀的同候选规则（精确到同一条规则，而非巧合同 weakestDim）
    expect(injected).toBeDefined();
    expect(injected!.weakestDim).toBe(first.precipitatedRule.weakestDim);
    expect(injected!.ts).toBe(first.precipitatedRule.ts);
    expect(contextStep?.summary).toContain('已注入历史经验规则');
  });

  it('候选隔离：跑过候选A后，候选B 的闭环不注入 A 的规则', async () => {
    await runClosedLoop({ ...LOOP_REQ, judge: mockJudge }); // 候选 fe-agent-07 沉淀规则
    const other = await runClosedLoop({
      ...LOOP_REQ,
      candidateId: 'be-agent-02',
      candidateName: 'BackendAgent-02',
      judge: mockJudge,
    });
    const contextStep = other.trace.find((t) => t.phase === 'context');
    const injected = (contextStep?.payload as { injectedRule?: unknown }).injectedRule;
    expect(injected).toBeUndefined();
    expect(contextStep?.summary).not.toContain('已注入历史经验规则');
  });
});
