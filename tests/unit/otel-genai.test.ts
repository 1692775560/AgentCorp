/**
 * SP-09 验收：LoopStep/token 用量可映射为 OTel GenAI 语义字段。
 */
import { describe, it, expect } from 'vitest';
import { toGenAiSpan, toGenAiTrace, toGenAiMetric } from '@/demo/observability/otelGenai';
import { runClosedLoop } from '@/demo/closedLoop';
import { mockJudge } from '@/demo/mockJudge';

describe('observability/otelGenai (SP-09)', () => {
  const step = {
    phase: 'approve' as const,
    agentRole: 'boss' as const,
    agentName: '老板（Manager）',
    skill: 'boss_review',
    summary: '老板决策：HIRE。',
    ts: 1723000000000,
  };

  it('toGenAiSpan 输出 gen_ai.* 规范字段且 agent 名/角色正确', () => {
    const span = toGenAiSpan(step, { conversationId: 'run-1', model: 'MiniCPM-o-4_5' });
    expect(span['gen_ai.system']).toBe('agentcorp');
    expect(span['gen_ai.agent.name']).toBe('老板（Manager）');
    expect(span['gen_ai.agent.role']).toBe('boss');
    expect(span['gen_ai.conversation.id']).toBe('run-1');
    expect(span['gen_ai.operation.name']).toBe('invoke_skill');
    expect(span['agentcorp.skill.id']).toBe('boss_review');
    expect(span['gen_ai.request.model']).toBe('MiniCPM-o-4_5');
    expect(span['agentcorp.loop.phase']).toBe('approve');
  });

  it('无 skill 的步骤映射为 loop.<phase> 操作', () => {
    const { skill: _drop, ...noSkill } = step;
    const span = toGenAiSpan({ ...noSkill, phase: 'input' }, { conversationId: 'run-1' });
    expect(span['gen_ai.operation.name']).toBe('loop.input');
    expect(span['agentcorp.skill.id']).toBeUndefined();
  });

  it('toGenAiMetric 含 token 与成本字段', () => {
    const metric = toGenAiMetric({
      timestamp: '2026-08-12T00:00:00Z',
      sessionId: 'sess-1',
      agentId: 'evaluator',
      model: 'MiniCPM-o-4_5',
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.015,
    });
    expect(metric['gen_ai.usage.input_tokens']).toBe(1200);
    expect(metric['gen_ai.usage.output_tokens']).toBe(300);
    expect(metric['gen_ai.usage.total_tokens']).toBe(1500);
    expect(metric['gen_ai.usage.cost_usd']).toBe(0.015);
    expect(metric['gen_ai.conversation.id']).toBe('sess-1');
    expect(metric['gen_ai.request.model']).toBe('MiniCPM-o-4_5');
  });

  it('toGenAiTrace：真实闭环 run 的全部步骤共享同一 conversation id', async () => {
    const res = await runClosedLoop({
      requirement: '招聘一名前端 Agent 工程师。',
      candidateId: 'fe-07',
      candidateName: 'FE-07',
      candidatePersona: 'p',
      transcript: '面试官：如何拆表单？\n候选：先复述需求。',
      k: 3,
      judge: mockJudge,
    });
    const spans = toGenAiTrace(res.trace, { conversationId: 'run-x' });
    expect(spans.length).toBe(res.trace.length);
    for (const s of spans) {
      expect(s['gen_ai.conversation.id']).toBe('run-x');
      expect(s['gen_ai.agent.name']).toBeTruthy();
    }
    // invoke_skill 操作确实存在（Skill 真实调用的 OTel 证据）
    expect(spans.some((s) => s['gen_ai.operation.name'] === 'invoke_skill')).toBe(true);
  });
});
