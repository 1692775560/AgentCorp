/**
 * HiClaw / AgentTeams CRD 映射验收（GOAI 1.1「以 AgentTeams 作为协同设计基点」）。
 *
 * 断言的是「映射真实存在且结构正确」，而不是「我们声称对齐了」。
 */
import { describe, it, expect } from 'vitest';
import {
  HICLAW_API_VERSION,
  toHiclawKind,
  roleCardToHiclawResource,
  buildHiclawTeam,
  exportHiclawManifest,
  MIGRATION_MATRIX,
} from '@/demo/agentteams/hiclawCrd';
import { ROLE_CARDS, ROLE_CARD_BY_ID } from '@/engine/agents/roleCard';

describe('HiClaw CRD 映射', () => {
  it('职能 → HiClaw Kind 的分层语义正确（管控/协作/执行三层）', () => {
    expect(toHiclawKind(ROLE_CARD_BY_ID.boss!)).toBe('TeamAdmin');
    expect(toHiclawKind(ROLE_CARD_BY_ID.dispatcher!)).toBe('TeamLeader');
    expect(toHiclawKind(ROLE_CARD_BY_ID.recruiter!)).toBe('Worker');
    expect(toHiclawKind(ROLE_CARD_BY_ID.evaluator!)).toBe('Worker');
  });

  it('资源信封符合 K8s CRD 形态（apiVersion/kind/metadata/spec）', () => {
    const res = roleCardToHiclawResource(ROLE_CARD_BY_ID.evaluator!);
    expect(res.apiVersion).toBe(HICLAW_API_VERSION);
    expect(res.apiVersion).toBe('hiclaw.io/v1beta1');
    expect(res.kind).toBe('Worker');
    expect(res.metadata.name).toBe('evaluator');
    expect(res.metadata.labels['hiclaw.io/risk-level']).toBe('medium');
    expect(res.spec).toBeTypeOf('object');
  });

  it('Skill 无损投影到 Worker.skills（GOAI 2.1 字段保留）', () => {
    const res = roleCardToHiclawResource(ROLE_CARD_BY_ID.evaluator!);
    const skills = (res.spec as { skills: Array<Record<string, unknown>> }).skills;
    expect(skills.map((s) => s.name)).toEqual(['capability_assessment', 'reliability_audit']);
    // 2.1 要求的字段没有在映射中丢失
    for (const s of skills) {
      expect(s.inputs).toBeTruthy();
      expect(s.outputs).toBeTruthy();
      expect(s.invokeCondition).toBeTruthy();
      expect(s.failureHandling).toBeTruthy();
      expect(s.securityBoundary).toBeTruthy();
    }
  });

  it('能力边界映射为 policy，人在回路标志被保留', () => {
    const boss = roleCardToHiclawResource(ROLE_CARD_BY_ID.boss!);
    const policy = (boss.spec as { policy: Record<string, unknown> }).policy;
    expect(policy.riskLevel).toBe('high');
    expect(policy.requiresHumanApproval).toBe(true);
    expect(policy.forbidden).toContain('直接执行工具调用');
  });

  it('Team 资源正确引用三层成员', () => {
    const team = buildHiclawTeam('agentcorp-core');
    const spec = team.spec as Record<string, unknown>;
    expect(team.kind).toBe('Team');
    expect(spec.teamAdmin).toBe('boss');
    expect(spec.teamLeader).toBe('dispatcher');
    expect(spec.workers).toEqual(['recruiter', 'evaluator']);
    // 通信底座与凭证托管的对照声明必须在（这是迁移论证的关键）
    expect((spec.transport as Record<string, unknown>).hiclawEquivalent).toBe('matrix');
    expect((spec.credentials as Record<string, unknown>).hiclawEquivalent).toBe(
      'higress-consumer-token',
    );
  });

  it('导出的多文档 YAML 含 Team + 全部 4 张角色卡', () => {
    const yaml = exportHiclawManifest();
    const docs = yaml.split('\n---\n');
    expect(docs).toHaveLength(1 + ROLE_CARDS.length); // Team + 4 卡
    expect(yaml).toContain('kind: Team');
    expect(yaml).toContain('kind: TeamAdmin');
    expect(yaml).toContain('kind: TeamLeader');
    expect(yaml).toContain('kind: Worker');
    // 诚实边界必须写在产物里，避免被误读为「已在 HiClaw 上跑通」
    expect(yaml).toContain('尚未在 HiClaw 控制面真实 reconcile');
  });

  it('迁移成本矩阵覆盖六个关注点，且只有控制面需新增工程', () => {
    expect(MIGRATION_MATRIX.length).toBeGreaterThanOrEqual(6);
    const needsNewWork = MIGRATION_MATRIX.filter((r) => r.cost === '需新增工程');
    expect(needsNewWork).toHaveLength(1);
    expect(needsNewWork[0]!.concern).toContain('控制面');
  });
});
