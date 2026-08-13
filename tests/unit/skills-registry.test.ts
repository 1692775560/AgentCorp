/**
 * SP-01 验收：Skill 注册表机制 + 角色卡投影覆盖 GOAI 2.1 全字段。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSkill,
  getSkill,
  listSkills,
  resetSkills,
  runSkill,
  projectSkill,
  type SkillDefinition,
} from '@/demo/skills/registry';
import { ROLE_CARDS, ROLE_CARD_BY_ID } from '@/engine/agents/roleCard';

const dummyHandler: SkillDefinition['handler'] = async () => ({ ok: true, degraded: false });

/** 把 4 张角色卡上的全部 Skill 投影注册（handler 用 dummy）。 */
function registerAllProjected(): void {
  for (const card of ROLE_CARDS) {
    for (const skill of card.skills) {
      registerSkill(projectSkill(card, skill, dummyHandler));
    }
  }
}

beforeEach(() => resetSkills());

describe('skills/registry (SP-01)', () => {
  it('投影注册后 listSkills 覆盖角色卡全部 5 个 Skill', () => {
    registerAllProjected();
    const ids = listSkills().map((s) => s.id);
    expect(ids).toHaveLength(5);
    expect(ids).toEqual(
      expect.arrayContaining([
        'boss_review',
        'agent_interview',
        'capability_assessment',
        'reliability_audit',
        'orchestrate',
      ]),
    );
  });

  it('getSkill 返回 GOAI 2.1 全字段且 handler 可调用', () => {
    registerAllProjected();
    const def = getSkill('boss_review');
    expect(def).toBeDefined();
    expect(def!.handler).toBeTypeOf('function');
    expect(def!.ownerAgent).toBe('boss');
    // GOAI 2.1 必填字段全部非空
    for (const key of [
      'name',
      'purpose',
      'inputs',
      'outputs',
      'invokeCondition',
      'failureHandling',
      'securityBoundary',
      'reuseValue',
      'collaboration',
    ] as const) {
      expect(def![key].length, `字段 ${key} 应非空`).toBeGreaterThan(0);
    }
    expect(def!.dependsOn).toEqual(['capability_assessment', 'reliability_audit']);
  });

  it('投影保留 ownerAgent 与角色卡一致', () => {
    const evaluator = ROLE_CARD_BY_ID.evaluator!;
    const def = projectSkill(evaluator, evaluator.skills[0]!, dummyHandler);
    expect(def.id).toBe('capability_assessment');
    expect(def.ownerAgent).toBe('evaluator');
  });

  it('runSkill 正常路径透传 handler 结果', async () => {
    registerSkill(
      projectSkill(ROLE_CARD_BY_ID.boss!, ROLE_CARD_BY_ID.boss!.skills[0]!, async (args) => ({
        ok: true,
        degraded: false,
        data: { echo: args.echo },
      })),
    );
    const res = await runSkill('boss_review', { echo: 42 });
    expect(res.ok).toBe(true);
    expect(res.degraded).toBe(false);
    expect((res.data as { echo: number }).echo).toBe(42);
  });

  it('runSkill 对未注册 skill 降级返回而不抛出', async () => {
    const res = await runSkill('nonexistent');
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    expect(res.reason).toContain('未注册');
  });

  it('runSkill 捕获 handler 异常并降级（失败处理机制）', async () => {
    registerSkill(
      projectSkill(ROLE_CARD_BY_ID.boss!, ROLE_CARD_BY_ID.boss!.skills[0]!, async () => {
        throw new Error('judge timeout');
      }),
    );
    const res = await runSkill('boss_review');
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    expect(res.reason).toContain('judge timeout');
  });
});
