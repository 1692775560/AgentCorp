/**
 * tests/unit/roleCard.test.ts
 * 结构化角色卡 schema 纯函数单测（无 electron 依赖）。
 * 运行：pnpm test
 */
import { describe, it, expect } from 'vitest';
import {
  agentToRoleCard,
  mergeRoleCard,
  roleCardToAgentSummary,
  toA2aAgentCard,
  ROLE_CARDS,
  ROLE_CARD_BY_ID,
  type RoleCard,
} from '@/engine/agents/roleCard';

describe('roleCard schema', () => {
  it('ROLE_CARDS 含 boss/recruiter/evaluator/dispatcher 四张异构职能卡', () => {
    const ids = ROLE_CARDS.map((c) => c.id).sort();
    expect(ids).toEqual(['boss', 'dispatcher', 'evaluator', 'recruiter']);
    expect(ROLE_CARDS.length).toBeGreaterThanOrEqual(3);
    expect(ROLE_CARD_BY_ID.boss.role).toBe('boss');
  });

  it('agentToRoleCard 从草稿构造完整卡，默认值安全且 boundaries 反映授权工具', () => {
    const card = agentToRoleCard({
      name: 'Data Analyst',
      role: 'specialist',
      boundedTools: ['sql', 'python'],
      authorityScope: '只读数据仓库',
    });
    expect(card.id).toBe('data-analyst');
    expect(card.role).toBe('specialist');
    expect(card.teamRole).toBe('worker');
    expect(card.lifecycleStatus).toBe('active');
    expect(card.boundedTools).toEqual(['sql', 'python']);
    expect(card.boundaries.allowed).toEqual(['sql', 'python']);
    expect(card.authorityScope).toBe('只读数据仓库');
    expect(card.skills).toEqual([]);
  });

  it('agentToRoleCard 缺省 role 回落 specialist，id 由名称稳定派生', () => {
    const a = agentToRoleCard({ name: 'X' });
    const b = agentToRoleCard({ name: 'X' });
    expect(a.id).toBe(b.id);
    expect(a.id).toBe('x');
    expect(a.role).toBe('specialist');
  });

  it('roleCardToAgentSummary 仅抽取兼容 AgentSummary 的子集', () => {
    const card = ROLE_CARD_BY_ID.boss;
    const s = roleCardToAgentSummary(card);
    expect(s.id).toBe('boss');
    expect(s.teamRole).toBe('leader');
    expect(s.persona).toBe(card.persona);
    expect(s.reportsTo).toBeUndefined();
  });

  it('mergeRoleCard override 覆盖 base，嵌套浅合并、数组整体替换（不拼接）', () => {
    const base: RoleCard = { ...ROLE_CARD_BY_ID.recruiter };
    const merged = mergeRoleCard(base, {
      goal: '新目标',
      skills: [
        {
          id: 's1',
          name: 'n',
          purpose: 'p',
          inputs: '',
          outputs: '',
          invokeCondition: '',
          dependsOn: [],
          failureHandling: '',
          securityBoundary: '',
          reuseValue: '',
          collaboration: '',
        },
      ],
    });
    expect(merged.goal).toBe('新目标');
    expect(merged.skills).toHaveLength(1); // 覆盖，不拼接 base 的 1 条
    expect(merged.capabilities).toEqual(base.capabilities); // 嵌套浅合并保留 base
  });

  it('toA2aAgentCard 投影 skills → {id,name,description}', () => {
    const card = ROLE_CARD_BY_ID.evaluator;
    const a2a = toA2aAgentCard(card);
    expect(a2a.protocol).toBe('google-a2a/1.0');
    expect(a2a.skills[0]).toEqual({
      id: 'capability_assessment',
      name: '多维能力评估',
      description: '六维雷达（任务/质量/沟通/创意/可靠/性价比）+ craft 维度评分。',
    });
  });
});
