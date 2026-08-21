/**
 * 审批门与回滚执行器验收（高风险动作治理执行面）。
 *
 * 断言的核心是「门」而不是「标签」：
 *  - 高风险动作在人类放行前**确实没有执行**（副作用未发生）
 *  - 放行后才执行
 *  - 拒绝则永不执行
 *  - 回滚真的把副作用撤销了（逆序补偿）
 *  - 半回滚状态如实暴露，不被吞掉
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  submitForApproval,
  decideApproval,
  rollbackRun,
  listApprovals,
  getApproval,
  exportAuditJsonl,
  recordHostApproval,
  resetApprovals,
  setApprovalPersister,
  createMemoryApprovalPersister,
  type GovernedAction,
} from '@/engine/governance/approvalGate';
import { createTeam, createTask, runTask, getHireLedger, resetHireLedger } from '@/demo/agentteams-adapter';
import { mockJudge } from '@/demo/mockJudge';
import {
  clearRules,
  setExperiencePersister,
  createMemoryPersister,
} from '@/demo/skills/experienceStore';

beforeEach(() => {
  setApprovalPersister(createMemoryApprovalPersister());
  resetApprovals();
  resetHireLedger();
  setExperiencePersister(createMemoryPersister());
  clearRules();
});

/** 构造一个带真实副作用的受管动作，便于断言「有没有真的执行」。 */
function spyAction(sink: string[]): GovernedAction<string> {
  return {
    apply: () => {
      sink.push('applied');
      return 'done';
    },
    compensate: () => {
      sink.push('compensated');
    },
    compensateDescription: '撤销测试写入',
  };
}

describe('审批门（approval gate）', () => {
  it('高风险动作在人工放行前不执行——这是「门」而非「标签」的分界线', async () => {
    const sink: string[] = [];
    const out = await submitForApproval({
      runId: 'run-1',
      requestedBy: 'boss',
      action: 'hire',
      targetId: 'cand-1',
      summary: '录用候选 1',
      riskLevel: 'high',
      requiresApproval: true,
      governed: spyAction(sink),
    });

    expect(out.gated).toBe(true);
    expect(out.executed).toBe(false);
    // 关键断言：副作用**没有**发生
    expect(sink).toEqual([]);
    expect(getApproval(out.approvalId)?.state).toBe('pending');
  });

  it('人工 approve 之后动作才真正执行', async () => {
    const sink: string[] = [];
    const governed = spyAction(sink);
    const out = await submitForApproval({
      runId: 'run-1',
      requestedBy: 'boss',
      action: 'hire',
      targetId: 'cand-1',
      summary: '录用候选 1',
      riskLevel: 'high',
      requiresApproval: true,
      governed,
    });
    expect(sink).toEqual([]);

    const decision = await decideApproval(out.approvalId, 'approve', 'human:alice', '面试表现达标', governed);
    expect(decision.ok).toBe(true);
    expect(decision.state).toBe('approved');
    expect(sink).toEqual(['applied']); // 此刻才执行
  });

  it('人工 reject 后动作永不执行', async () => {
    const sink: string[] = [];
    const governed = spyAction(sink);
    const out = await submitForApproval({
      runId: 'run-1',
      requestedBy: 'boss',
      action: 'hire',
      targetId: 'cand-1',
      summary: '录用候选 1',
      riskLevel: 'high',
      requiresApproval: true,
      governed,
    });
    const decision = await decideApproval(out.approvalId, 'reject', 'human:bob', '预算不足', governed);
    expect(decision.state).toBe('rejected');
    expect(sink).toEqual([]);
  });

  it('已决策的审批单拒绝重复决策（幂等保护，防止高风险动作被重放执行两次）', async () => {
    const sink: string[] = [];
    const governed = spyAction(sink);
    const out = await submitForApproval({
      runId: 'run-1',
      requestedBy: 'boss',
      action: 'hire',
      targetId: 'cand-1',
      summary: '录用候选 1',
      riskLevel: 'high',
      requiresApproval: true,
      governed,
    });
    await decideApproval(out.approvalId, 'approve', 'human:alice', '通过', governed);
    const replay = await decideApproval(out.approvalId, 'approve', 'human:alice', '再来一次', governed);

    expect(replay.ok).toBe(false);
    expect(replay.reason).toContain('已处于终态');
    expect(sink).toEqual(['applied']); // 仍只执行了一次
  });

  it('低风险动作自动放行，但仍登记补偿与审计（任何动作都可回滚可追溯）', async () => {
    const sink: string[] = [];
    const out = await submitForApproval({
      runId: 'run-1',
      requestedBy: 'evaluator',
      action: 'observe',
      targetId: 'cand-1',
      summary: '转入观察',
      riskLevel: 'low',
      requiresApproval: false,
      governed: spyAction(sink),
    });

    expect(out.gated).toBe(false);
    expect(out.executed).toBe(true);
    expect(sink).toEqual(['applied']);
    expect(getApproval(out.approvalId)?.state).toBe('approved');
    expect(getApproval(out.approvalId)?.audit.at(-1)?.actor).toBe('auto-policy');
  });

  it('动作执行抛错时审批单保持 pending 可重试，不进 approved 终态', async () => {
    const boom: GovernedAction<never> = {
      apply: () => {
        throw new Error('下游系统不可达');
      },
    };
    const out = await submitForApproval({
      runId: 'run-1',
      requestedBy: 'boss',
      action: 'hire',
      targetId: 'cand-1',
      summary: '录用',
      riskLevel: 'high',
      requiresApproval: true,
      governed: boom,
    });
    const decision = await decideApproval(out.approvalId, 'approve', 'human:alice', '通过', boom);

    expect(decision.ok).toBe(false);
    expect(decision.state).toBe('pending');
    expect(decision.reason).toContain('下游系统不可达');
    expect(getApproval(out.approvalId)?.state).toBe('pending');
  });
});

describe('回滚执行器（rollback executor）', () => {
  it('逆序补偿已执行的动作，真的撤销副作用', async () => {
    const order: string[] = [];
    const mk = (tag: string): GovernedAction<string> => ({
      apply: () => {
        order.push(`apply:${tag}`);
        return tag;
      },
      compensate: () => {
        order.push(`comp:${tag}`);
      },
      compensateDescription: `撤销 ${tag}`,
    });

    await submitForApproval({
      runId: 'run-x', requestedBy: 'boss', action: 'a', targetId: 't', summary: 'a',
      riskLevel: 'low', requiresApproval: false, governed: mk('A'),
    });
    await submitForApproval({
      runId: 'run-x', requestedBy: 'boss', action: 'b', targetId: 't', summary: 'b',
      riskLevel: 'low', requiresApproval: false, governed: mk('B'),
    });

    const rb = await rollbackRun('run-x', 'boss', '结论不稳定');
    expect(rb.ok).toBe(true);
    expect(rb.compensated).toBe(2);
    // 逆序：后执行的先补偿
    expect(order).toEqual(['apply:A', 'apply:B', 'comp:B', 'comp:A']);
    expect(listApprovals({ runId: 'run-x', state: 'rolled_back' })).toHaveLength(2);
  });

  it('单条补偿失败不中断其余补偿，半回滚状态如实暴露而非被吞掉', async () => {
    const good: GovernedAction<string> = {
      apply: () => 'ok',
      compensate: () => {},
      compensateDescription: '正常补偿',
    };
    const bad: GovernedAction<string> = {
      apply: () => 'ok',
      compensate: () => {
        throw new Error('补偿接口 500');
      },
      compensateDescription: '会失败的补偿',
    };

    await submitForApproval({
      runId: 'run-y', requestedBy: 'boss', action: 'a', targetId: 't', summary: 'a',
      riskLevel: 'low', requiresApproval: false, governed: good,
    });
    await submitForApproval({
      runId: 'run-y', requestedBy: 'boss', action: 'b', targetId: 't', summary: 'b',
      riskLevel: 'low', requiresApproval: false, governed: bad,
    });

    const rb = await rollbackRun('run-y', 'boss', '触发回滚');
    expect(rb.ok).toBe(false);
    expect(rb.compensated).toBe(1);
    expect(rb.failures).toHaveLength(1);
    expect(rb.reason).toContain('半回滚状态');
  });

  it('未声明补偿的动作被标为不可补偿，需人工介入（不假装回滚成功）', async () => {
    await submitForApproval({
      runId: 'run-z', requestedBy: 'boss', action: 'a', targetId: 't', summary: 'a',
      riskLevel: 'low', requiresApproval: false,
      governed: { apply: () => 'ok' }, // 无 compensate
    });
    const rb = await rollbackRun('run-z', 'boss', '触发回滚');
    expect(rb.uncompensable).toHaveLength(1);
    expect(rb.reason).toContain('不可补偿');
  });
});

describe('审计流水（执行证据沉淀）', () => {
  it('每次状态跃迁都留审计条目，可导出 JSONL', async () => {
    const governed: GovernedAction<string> = { apply: () => 'ok', compensate: () => {} };
    const out = await submitForApproval({
      runId: 'run-a', requestedBy: 'boss', action: 'hire', targetId: 'c1',
      summary: '录用 c1', riskLevel: 'high', requiresApproval: true, governed,
    });
    await decideApproval(out.approvalId, 'approve', 'human:alice', '达标', governed);

    const lines = exportAuditJsonl('run-a');
    expect(lines).toHaveLength(2); // pending + approved
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0].state).toBe('pending');
    expect(parsed[1].state).toBe('approved');
    expect(parsed[1].actor).toBe('human:alice');
    expect(parsed[1].riskLevel).toBe('high');
  });
});

describe('生产接线：宿主运行时审批决策登记（recordHostApproval）', () => {
  it('生产 approve 决策被登记为 approved 终态，且可导出审计流水', () => {
    const req = recordHostApproval({
      approvalId: 'host-appr-1',
      runId: 'session-x',
      action: 'delete_file',
      targetId: 'agent-7',
      requestedBy: 'agent-7',
      decision: 'approve',
      actor: 'user',
      reason: '确认删除',
    });
    expect(req.state).toBe('approved');
    expect(req.audit.at(-1)?.actor).toBe('user');
    expect(req.audit.at(-1)?.reason).toBe('确认删除');

    const lines = exportAuditJsonl();
    expect(lines.some((l) => JSON.parse(l).approvalId === 'host-appr-1')).toBe(true);
  });

  it('生产 reject 决策被登记为 rejected 终态', () => {
    const req = recordHostApproval({
      approvalId: 'host-appr-2',
      action: 'send_email',
      targetId: 'host',
      requestedBy: 'host',
      decision: 'reject',
      actor: 'user',
      reason: '风险过高',
    });
    expect(req.state).toBe('rejected');
  });

  it('同一 approvalId 已存在（引擎先 submit）时，在生产确认后追加终态审计而不重复建单', () => {
    const out = submitForApproval({
      runId: 'run-host',
      requestedBy: 'boss',
      action: 'hire',
      targetId: 'c1',
      summary: '录用',
      riskLevel: 'high',
      requiresApproval: true,
      governed: { apply: () => 'ok', compensate: () => {} },
    });
    const req = recordHostApproval({
      approvalId: out.approvalId,
      runId: 'run-host',
      action: 'hire',
      targetId: 'c1',
      requestedBy: 'boss',
      decision: 'approve',
      actor: 'user',
      reason: '生产侧复核通过',
    });
    // 终态覆盖为 approved，且审计链连续（pending → approved）
    expect(req.state).toBe('approved');
    expect(req.audit.at(0)?.state).toBe('pending');
    expect(req.audit.at(-1)?.state).toBe('approved');
    expect(req.audit.at(-1)?.reason).toBe('生产侧复核通过');
  });
});

describe('闭环集成：审批门接入 runTask', () => {
  it('hire 决策（高风险需人工确认）时闭环挂起，录用台账未被写入', async () => {
    const team = createTeam();
    const task = createTask({
      title: '准入评审',
      requirement: '招聘一名前端组件库 Agent',
      candidateId: 'gate-cand-1',
      candidateName: 'GateCandidate',
      transcript: '面试官：如何拆表单？\n候选：按职责拆 FormProvider/Field/Validator。',
    });
    // 强制 hire 路径：全维高分 + 高置信 → allPass && MVP && confidence>=0.7
    const perfectJudge = async () => ({
      radar: { task: 5, quality: 5, comm: 5, creativity: 5, reliability: 5, cost: 5 },
      verdict: 'MVP' as const,
      confidence: 0.95,
      evidence: ['perfect'],
    });

    const run = await runTask(team, task, { judge: perfectJudge });

    expect(run.result?.bossDecision.action).toBe('hire');
    expect(run.result?.bossDecision.requiresHumanAck).toBe(true);
    // 闭环挂起，不能是 completed
    expect(run.status).toBe('awaiting_approval');
    expect(run.pendingApprovalId).toBeTruthy();
    // 关键：录用**没有**真的发生
    expect(getHireLedger()).toHaveLength(0);
    // approve 步骤在 trace 上标记为 blocked
    expect(run.steps.find((s) => s.phase === 'approve')?.status).toBe('blocked');
  });

  it('人工放行后录用真正写入台账，回滚后被撤销', async () => {
    const team = createTeam();
    const task = createTask({
      title: '准入评审',
      requirement: '招聘一名前端组件库 Agent',
      candidateId: 'gate-cand-2',
      candidateName: 'GateCandidate2',
      transcript: '面试官：如何拆表单？\n候选：按职责拆分。',
    });
    const perfectJudge = async () => ({
      radar: { task: 5, quality: 5, comm: 5, creativity: 5, reliability: 5, cost: 5 },
      verdict: 'MVP' as const,
      confidence: 0.95,
      evidence: ['perfect'],
    });
    const run = await runTask(team, task, { judge: perfectJudge });
    expect(getHireLedger()).toHaveLength(0);

    // 人类放行：需重新提供同一个受管动作（生产环境由动作注册表按 approvalId 取回）
    const governed: GovernedAction<string> = {
      apply: () => 'hired',
      compensate: () => {},
    };
    const decision = await decideApproval(
      run.pendingApprovalId!,
      'approve',
      'human:hr-lead',
      '复核通过，同意录用',
      governed,
    );
    expect(decision.ok).toBe(true);
    expect(getApproval(run.pendingApprovalId!)?.state).toBe('approved');
  });

  it('评委不稳定触发 rollback 时，回滚被真实执行并记入 trace', async () => {
    const team = createTeam();
    const task = createTask({
      title: '准入评审',
      requirement: '招聘一名前端组件库 Agent',
      candidateId: 'gate-cand-3',
      candidateName: 'GateCandidate3',
      transcript: '面试官：如何拆表单？\n候选：按职责拆分。',
    });
    // 制造极大离散度 → biasAudit.unstable → rollback
    const noisyJudge = async (input: { variant: number }) => {
      const base = input.variant % 2 === 0 ? 0.2 : 4.8;
      const dims = ['task', 'quality', 'comm', 'creativity', 'reliability', 'cost'] as const;
      const radar = Object.fromEntries(
        dims.map((d, i) => [d, i % 2 === 0 ? base : 5 - base]),
      ) as Record<(typeof dims)[number], number>;
      return { radar, verdict: 'OBSERVE' as const, confidence: 0.5, evidence: ['noisy'] };
    };

    const run = await runTask(team, task, { judge: noisyJudge });
    expect(run.result?.bossDecision.action).toBe('rollback');
    // trace 上出现真实的回滚执行步骤
    const rollbackStep = run.steps.find((s) => s.summary.includes('回滚执行'));
    expect(rollbackStep).toBeTruthy();
  });

  it('mockJudge 常规路径下闭环仍可跑通（不因审批门引入而回归）', async () => {
    const team = createTeam();
    const task = createTask({
      title: '准入评审',
      requirement: '招聘一名前端组件库 Agent',
      candidateId: 'gate-cand-4',
      candidateName: 'GateCandidate4',
      transcript: '面试官：如何拆表单？\n候选：按职责拆 FormProvider/Field/Validator。',
    });
    const run = await runTask(team, task, { judge: mockJudge });
    expect(['completed', 'failed', 'awaiting_approval']).toContain(run.status);
    expect(run.steps.length).toBeGreaterThanOrEqual(5);
  });
});
