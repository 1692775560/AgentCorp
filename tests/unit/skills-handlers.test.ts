/**
 * SP-02 验收：5 个内建 Skill handler 可用、失败降级不抛、决策语义正确。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getSkill, listSkills, runSkill, registerSkill } from '@/demo/skills/registry';
import {
  registerBuiltinSkills,
  bossReviewDecision,
  type BossReviewOutput,
  type CapabilityAssessment,
  type InterviewReport,
  type PrecipitatedRule,
  type ReliabilityAudit,
} from '@/demo/skills/handlers';
import { projectSkill } from '@/demo/skills/registry';
import { ROLE_CARD_BY_ID } from '@/engine/agents/roleCard';
import { clearRules, latestRule, setExperiencePersister, createMemoryPersister } from '@/demo/skills/experienceStore';
import { passK } from '@/engine/evaluation/passK';
import { auditJudgeBias } from '@/services/judgeClient';
import { aggregateRadars } from '@/services/judgeEnsemble';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import type { RadarScore } from '@/types/evaluation';
import type { JudgeFn } from '@/demo/closedLoop';

registerBuiltinSkills();

beforeEach(() => {
  // QA-8：经验 Store 是模块级单例，每个用例前重置，避免跨用例累积
  setExperiencePersister(createMemoryPersister());
  clearRules();
});

const radar = (v: number): RadarScore => ({
  task: v,
  quality: v,
  comm: v,
  creativity: v,
  reliability: v,
  cost: v,
});

const nullJudge: JudgeFn = async () => null;
const goodJudge: JudgeFn = async () => ({
  radar: radar(4.5),
  verdict: 'MVP',
  confidence: 0.9,
  evidence: ['结构化回答完整'],
});

function evalInput(radars: RadarScore[], verdict: 'MVP' | 'OBSERVE' | 'FIRED' | null, confidence: number) {
  return {
    passK: passK(radars, { k: radars.length, threshold: 3.5 }),
    biasAudit: auditJudgeBias(radars),
    verdict,
    confidence,
    meanRadar: aggregateRadars(radars),
  };
}

describe('skills/handlers (SP-02)', () => {
  it('模块加载后 5 个内建 Skill 全部注册且 handler 可调', () => {
    expect(listSkills()).toHaveLength(5);
    expect(getSkill('boss_review')?.handler).toBeTypeOf('function');
    expect(getSkill('orchestrate')?.ownerAgent).toBe('dispatcher');
  });

  it('agent_interview：转录为空降级不臆造；有转录产出 InterviewReport', async () => {
    const empty = await runSkill('agent_interview', { candidateId: 'a1', transcript: '  ' });
    expect(empty.ok).toBe(false);
    expect(empty.degraded).toBe(true);

    const ok = await runSkill('agent_interview', { candidateId: 'a1', transcript: '问：如何做缓存？答：……' });
    expect(ok.ok).toBe(true);
    const report = ok.data as InterviewReport;
    expect(report.targetDims).toEqual(RADAR_DIMS);
    expect(report.transcriptLen).toBeGreaterThan(0);
  });

  it('capability_assessment：judge 全 null 时返回 degraded 不抛', async () => {
    const res = await runSkill('capability_assessment', {
      candidateId: 'a1',
      transcript: 't',
      k: 3,
      judge: nullJudge,
    });
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    expect((res.data as CapabilityAssessment).source).toBe('degraded');
  });

  it('capability_assessment：正常路径聚合均值雷达与多数裁决', async () => {
    const res = await runSkill('capability_assessment', {
      candidateId: 'a1',
      transcript: 't',
      k: 3,
      judge: goodJudge,
    });
    expect(res.ok).toBe(true);
    const data = res.data as CapabilityAssessment;
    expect(data.radars).toHaveLength(3);
    expect(data.meanRadar.task).toBeCloseTo(4.5);
    expect(data.verdict).toBe('MVP');
    expect(data.source).toBe('judge');
  });

  it('reliability_audit：空样本降级；正常样本产出 passK + biasAudit', async () => {
    const empty = await runSkill('reliability_audit', { radars: [] });
    expect(empty.ok).toBe(false);
    expect(empty.degraded).toBe(true);

    const res = await runSkill('reliability_audit', { radars: [radar(4), radar(4.2), radar(3.8)] });
    expect(res.ok).toBe(true);
    const data = res.data as ReliabilityAudit;
    expect(data.passK.allPass).toBe(true);
    expect(data.biasAudit.unstable).toBe(false);
  });

  it('boss_review：unstable=true 时 action=rollback 且 requiresHumanAck=true', async () => {
    // 极差 4.0 > 阈值 1.5 → unstable
    const res = await runSkill('boss_review', {
      evaluation: evalInput([radar(1), radar(5)], null, 0.5),
    });
    expect(res.ok).toBe(true);
    const out = res.data as BossReviewOutput;
    expect(out.action).toBe('rollback');
    expect(out.requiresHumanAck).toBe(true);
  });

  it('boss_review：allPass+MVP+conf≥0.7 → hire；低通过率 → reject', async () => {
    const hire = await runSkill('boss_review', {
      evaluation: evalInput([radar(4.5), radar(4.6), radar(4.4)], 'MVP', 0.9),
      candidateName: '测试候选',
    });
    expect((hire.data as BossReviewOutput).action).toBe('hire');
    expect((hire.data as BossReviewOutput).requiresHumanAck).toBe(true); // 高风险动作需人工确认

    const reject = await runSkill('boss_review', {
      evaluation: evalInput([radar(2), radar(2.1), radar(1.9)], 'FIRED', 0.4),
    });
    expect((reject.data as BossReviewOutput).action).toBe('reject');
  });

  it('boss_review：降级评估（source=degraded）不沉淀经验规则（H3 防线）', async () => {
    const res = await runSkill('boss_review', {
      evaluation: { ...evalInput([radar(4.5), radar(4.6)], 'MVP', 0.9), source: 'degraded' },
      candidateId: 'c-deg',
    });
    expect(res.ok).toBe(true); // 决策照常产出
    expect(latestRule('c-deg')).toBeNull(); // 但不沉淀垃圾规则
  });

  it('boss_review：形状非法输入（passK 是字符串 / confidence NaN）→ 强制转人工（M1）', async () => {
    const bad1 = await runSkill('boss_review', { evaluation: { passK: 'abc' } });
    expect(bad1.ok).toBe(false);
    expect(bad1.reason).toContain('转人工');

    const good = evalInput([radar(4.5), radar(4.6)], 'MVP', 0.9);
    const bad2 = await runSkill('boss_review', {
      evaluation: { ...good, confidence: Number.NaN },
    });
    expect(bad2.ok).toBe(false);
    expect(bad2.degraded).toBe(true);
  });

  it('H2：registerBuiltinSkills 不覆盖调用方注入的 mock handler', async () => {
    const sentinel = async () => ({ ok: true, degraded: false, data: { mock: true } });
    registerSkill(projectSkill(ROLE_CARD_BY_ID.boss!, ROLE_CARD_BY_ID.boss!.skills[0]!, sentinel));
    registerBuiltinSkills(); // 入口幂等调用不应 clobber mock
    const res = await runSkill('boss_review', {});
    expect((res.data as { mock: boolean }).mock).toBe(true);
    // 恢复内建 handler，避免影响后续用例
    registerSkill(
      projectSkill(ROLE_CARD_BY_ID.boss!, ROLE_CARD_BY_ID.boss!.skills[0]!, (await import('@/demo/skills/handlers')).bossReviewHandler),
    );
  });

  it('boss_review：评估输入不完整 → 强制转人工（degraded），不自动决策', async () => {
    const res = await runSkill('boss_review', { evaluation: { verdict: 'MVP' } });
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    expect(res.reason).toContain('转人工');
  });

  it('boss_review 产出结构化 precipitatedRule（最弱维=训练重点）', () => {
    const uneven: RadarScore = { task: 4.5, quality: 4.5, comm: 4.5, creativity: 2, reliability: 4.5, cost: 4.5 };
    const out = bossReviewDecision({ ...evalInput([uneven, uneven], 'MVP', 0.9), candidateName: '测试候选' });
    const rule: PrecipitatedRule = out.precipitatedRule;
    expect(rule.source).toBe('boss_review');
    expect(rule.weakestDim).toBe('creativity');
    expect(rule.strongestDim).toBe('task');
    expect(rule.trainingFocus).toContain('creativity');
    expect(rule.rule).toContain('测试');
  });

  it('orchestrate：缺 judge 降级；注入 mock judge 端到端跑通闭环', async () => {
    const bad = await runSkill('orchestrate', { request: { candidateId: 'a1' } });
    expect(bad.ok).toBe(false);
    expect(bad.degraded).toBe(true);

    const res = await runSkill('orchestrate', {
      request: {
        requirement: '招聘一名工程岗 Agent',
        candidateId: 'a1',
        candidateName: 'A1',
        candidatePersona: 'p',
        transcript: '结构化面试转录',
        k: 3,
        judge: goodJudge,
      },
    });
    expect(res.ok).toBe(true);
    expect(res.data).toHaveProperty('bossDecision');
  });
});
