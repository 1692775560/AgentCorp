import { describe, it, expect, beforeEach } from 'vitest';
import {
  toAgentTeamsAgent,
  createTeam,
  createTask,
  runTask,
  invokeSkill,
  listTeamSkills,
} from '@/demo/agentteams-adapter';
import { ROLE_CARDS, ROLE_CARD_BY_ID } from '@/engine/agents/roleCard';
import { mockJudge } from '@/demo/mockJudge';
import { clearRules, setExperiencePersister, createMemoryPersister } from '@/demo/skills/experienceStore';

beforeEach(() => {
  // 经验 Store 是模块级单例，逐用例重置避免跨用例注入污染
  setExperiencePersister(createMemoryPersister());
  clearRules();
});

const TASK_INPUT = {
  title: '招募前端 Agent',
  requirement: '招聘前端组件库 Agent',
  candidateId: 'fe-07',
  candidateName: 'FrontendAgent-07',
  transcript: '面试官：如何拆分表单？\n候选：先复述需求，再按职责拆为 FormProvider/Field/Validator/ErrorSummary。',
};

describe('AgentTeams 薄适配（决策 X 实证）', () => {
  it('roleCard 映射为 AgentTeams Agent，含身份/能力/边界', () => {
    const at = toAgentTeamsAgent(ROLE_CARD_BY_ID.evaluator);
    expect(at.agentId).toBe('evaluator');
    expect(at.role).toBe('evaluator');
    expect(at.capabilities.length).toBeGreaterThan(0); // 能力投影
    expect(at.boundaries.riskLevel).toBe('medium');
    expect(at.boundaries.forbidden).toContain('录用');
  });

  it('Team 含 ≥3 个异构职能 Agent', () => {
    const team = createTeam();
    const roles = team.agents.map((a) => a.role);
    expect(roles).toEqual(expect.arrayContaining(['boss', 'recruiter', 'evaluator']));
    expect(team.sharedContext.length).toBeGreaterThan(0); // 上下文通道
  });

  it('Task 含任务拆解与候选上下文', () => {
    const task = createTask({
      title: '招募前端 Agent',
      requirement: '招聘前端组件库 Agent',
      candidateId: 'fe-07',
      candidateName: 'FrontendAgent-07',
      transcript: '面试官：如何拆分表单？\n候选：先复述需求再拆分。',
    });
    expect(task.decomposition.length).toBeGreaterThan(0);
    expect(task.candidateId).toBe('fe-07');
  });

  it('runTask 端到端产出 AgentTeams Run（状态追踪 + 结果）', async () => {
    const team = createTeam();
    const task = createTask({ ...TASK_INPUT });
    const run = await runTask(team, task, { judge: mockJudge });
    // 状态与决策/降级语义一致（非恒真话断言）：rollback 或评估降级 → failed
    const expected =
      run.result!.bossDecision.action === 'rollback' || run.result!.evaluation.source === 'degraded'
        ? 'failed'
        : 'completed';
    expect(run.status).toBe(expected);
    expect(run.steps.length).toBeGreaterThanOrEqual(5);
    expect(run.result?.bossDecision.action).toBeTruthy();
    expect(ROLE_CARDS.length).toBeGreaterThanOrEqual(3);
  });

  it('listTeamSkills 投影团队全部 5 个 Skill 且带 ownerAgent', () => {
    const team = createTeam();
    const skills = listTeamSkills(team);
    expect(skills).toHaveLength(5);
    const ownerOf = Object.fromEntries(skills.map((s) => [s.skillId, s.ownerAgent]));
    expect(ownerOf.boss_review).toBe('boss');
    expect(ownerOf.agent_interview).toBe('recruiter');
    expect(ownerOf.capability_assessment).toBe('evaluator');
    expect(ownerOf.reliability_audit).toBe('evaluator');
    expect(ownerOf.orchestrate).toBe('dispatcher');
  });

  it('invokeSkill 校验能力边界（owner 不在团队 / skill 未注册 → 降级不抛）', async () => {
    const team = createTeam('t1', [ROLE_CARD_BY_ID.recruiter!]); // 只有 recruiter
    const outOfTeam = await invokeSkill(team, 'boss_review', {});
    expect(outOfTeam.ok).toBe(false);
    expect(outOfTeam.degraded).toBe(true);
    expect(outOfTeam.reason).toContain('不在团队');

    const missing = await invokeSkill(createTeam(), 'nonexistent_skill', {});
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain('未注册');

    // 正常路径：recruiter 在团队内可调 agent_interview
    const ok = await invokeSkill(team, 'agent_interview', {
      candidateId: 'fe-07',
      transcript: TASK_INPUT.transcript,
    });
    expect(ok.ok).toBe(true);
  });

  it('runTask 经 invokeSkill 串联，steps 带 Agent + Skill 标签', async () => {
    const team = createTeam();
    const task = createTask({ ...TASK_INPUT });
    const run = await runTask(team, task, { judge: mockJudge });

    const skillByPhase = Object.fromEntries(run.steps.map((s) => [s.phase, s.skill]));
    expect(skillByPhase.context).toBe('agent_interview');
    expect(skillByPhase.tool).toBe('capability_assessment');
    expect(skillByPhase.verify).toBe('reliability_audit');
    expect(skillByPhase.approve).toBe('boss_review');
    expect(skillByPhase.precipitate).toBe('boss_review');

    // 步骤标注执行 Agent（boss/recruiter/evaluator/dispatcher 链路可见）
    const agents = new Set(run.steps.map((s) => s.agent));
    expect([...agents].join()).toContain('HR 面试官');
    expect([...agents].join()).toContain('评估中心');
    expect([...agents].join()).toContain('老板');

    // 决策来源是 boss_review Skill
    expect(run.result?.bossDecision.source).toBe('boss_review');
  });

  it('judge 全失败时闭环降级但不中断（run 仍产出结构完整结果）', async () => {
    const team = createTeam();
    const task = createTask({ ...TASK_INPUT });
    const run = await runTask(team, task, { judge: async () => null });
    expect(run.result?.evaluation.source).toBe('degraded');
    expect(run.status).toBe('failed'); // M2：评估整体降级不算 completed
    expect(run.steps.find((s) => s.phase === 'tool')?.status).toBe('warn');
    expect(run.result?.bossDecision.action).toBe('reject'); // 降级路径的具体决策
    expect(run.steps.length).toBeGreaterThanOrEqual(5);
  });

  it('拆解随候选岗位动态变化（非硬编码）', async () => {
    const { decomposeTask, detectJobType } = await import('@/demo/agentteams-adapter');
    expect(detectJobType('招聘一名海报视觉设计 Agent')).toBe('image');
    expect(detectJobType('招聘一名文案写作 Agent')).toBe('text');
    expect(detectJobType('招聘一名前端组件库 Agent')).toBe('code');

    const imagePlan = decomposeTask({ requirement: '招聘一名海报视觉设计 Agent' });
    const codePlan = decomposeTask({ requirement: '招聘一名前端组件库 Agent' });
    expect(imagePlan.jobType).toBe('image');
    expect(codePlan.jobType).toBe('code');
    expect(imagePlan.steps[0]).toContain('image');
    expect(codePlan.steps[0]).toContain('code');
    expect(imagePlan.steps[0]).not.toBe(codePlan.steps[0]);

    // createTask 使用动态拆解
    const task = createTask({ ...TASK_INPUT, requirement: '招聘一名海报视觉设计 Agent' });
    expect(task.decomposition[0]).toContain('岗位类型=image');
  });

  it('runTask 消费 team.sharedContext（上下文随步骤传递且非空）', async () => {
    const team = createTeam();
    const task = createTask({ ...TASK_INPUT });
    const run = await runTask(team, task, { judge: mockJudge });

    // decompose 与 context 步骤的 payload 带出来自 team.sharedContext 的上下文
    const trace = run.result!.trace;
    const decompose = trace.find((t) => t.phase === 'decompose');
    const context = trace.find((t) => t.phase === 'context');
    expect((decompose?.payload as { sharedContext: string[] }).sharedContext).toEqual(team.sharedContext);
    expect((context?.payload as { sharedContext: string[] }).sharedContext).toEqual(team.sharedContext);
    expect(team.sharedContext.length).toBeGreaterThan(0);

    // 拆解随岗位体现在 plan 中
    expect(run.result?.plan.jobType).toBe('code');
  });
});
