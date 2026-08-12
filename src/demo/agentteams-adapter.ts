/**
 * AgentTeams 薄适配层（GOAI 决策 X 落地 · 不引第三方运行时）
 * --------------------------------------------------------------------------
 * 阿里 GOAI 赛题要求「以 AgentTeams 作为协同设计基点」。AgentCorp 主线上跑 OpenClaw，
 * 不引入 langgraph/crewai/agentteams 等第三方编排运行时（架构决策见 MEMORY.md）。
 *
 * 本文件即「薄适配」：在 OpenClaw 之上**暴露 AgentTeams 形态的 API**
 * （Agent / Team / Task / Run / Skill），底层仍由既有 roleCard + 评估中心 +
 * Skill 注册表驱动。它不是换引擎，而是**语义映射层**——使评审方能直接对照
 * AgentTeams 的协同基元（角色编排 / 任务拆解 / 上下文传递 / 协同执行 / 状态追踪）
 * 看 AgentCorp 的对应实现。
 *
 * SP-04：`runTask` 不再直连 judge——而是经 `invokeSkill` 逐阶段调用
 * recruiter→agent_interview、evaluator→capability_assessment + reliability_audit、
 * boss→boss_review，每个 run.steps 都带 `skill` 标签（Skill 真实调用证据）。
 *
 * 复赛若需真接入 AgentTeams，仅需把下列类型替换为 AgentTeams SDK 的真实类型、
 * 把 invokeSkill 的内部委托换成 AgentTeams 的 skill 调用，
 * 工具调用链与角色卡/Skill 定义均无需重设计（迁移成本见 artifacts/agentteams-adapter-design.md；
 * 工具面契约见 docs/artifacts/mcp-equivalent-contract.md）。
 */
import type { RoleCard } from '@/engine/agents/roleCard';
import { ROLE_CARDS, ROLE_CARD_BY_ID } from '@/engine/agents/roleCard';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import { passK } from '@/engine/evaluation/passK';
import { auditJudgeBias } from '@/services/judgeClient';
import type { BossProfile, Verdict } from '@/types/evaluation';
import type {
  BossAction,
  ClosedLoopRequest,
  ClosedLoopResult,
  JudgeFn,
  LoopStep,
} from './closedLoop';
import { demoJudge } from './liveJudge';
import { getSkill, runSkill, type SkillResult } from './skills/registry';
import { latestRule } from './skills/experienceStore';
import {
  registerBuiltinSkills,
  bossReviewDecision,
  type BossReviewOutput,
  type CapabilityAssessment,
  type InterviewReport,
  type ReliabilityAudit,
} from './skills/handlers';

/* ───────────── AgentTeams 形态基元（薄映射类型，非第三方依赖） ───────────── */

/** AgentTeams · Agent：身份定义（对应 GOAI 附录A + roleCard） */
export interface ATAgent {
  agentId: string;
  name: string;
  /** role = roleCard.role，作为 AgentTeams 的角色标识 */
  role: RoleCard['role'];
  description: string; // goal + backstory 合成
  capabilities: string[]; // 由 roleCard.skills 投影
  boundaries: {
    allowed: string[];
    forbidden: string[];
    riskLevel: string;
    requiresApproval: boolean;
  };
}

/** AgentTeams · Skill（SP-04）：团队内可被调用的技能单元（对应 Skill 注册表投影） */
export interface ATSkill {
  skillId: string;
  name: string;
  ownerAgent: string; // roleCard id（boss / recruiter / evaluator / dispatcher）
  boundaries: {
    allowed: string[];
    forbidden: string[];
    riskLevel: string;
    requiresApproval: boolean;
  };
}

/** AgentTeams · Team：多 Agent 协同单元（对应 dispatcher 编排的团队） */
export interface ATTeam {
  teamId: string;
  name: string;
  agents: ATAgent[];
  /** 共享上下文通道（上下文传递的载体） */
  sharedContext: string[];
}

/** AgentTeams · Task：任务单元（对应 boss 的任务输入 + dispatcher 拆解） */
export interface ATTask {
  taskId: string;
  title: string;
  requirement: string;
  candidateId: string;
  candidateName: string;
  transcript: string;
  decomposition: string[]; // 任务拆解结果
}

/** AgentTeams · Run：一次协同执行（对应八步闭环，带状态追踪） */
export interface ATRun {
  runId: string;
  teamId: string;
  taskId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  /** 协同执行轨迹：每一步标注执行 Agent + 调用的 Skill + 状态（状态追踪） */
  steps: Array<{
    phase: string;
    agent: string;
    /** 该步经 invokeSkill 真实调用的 Skill id（无 Skill 的阶段省略） */
    skill?: string;
    summary: string;
    status: 'ok' | 'warn' | 'blocked';
  }>;
  result?: ClosedLoopResult;
}

/* ───────────── 映射函数（roleCard → AgentTeams 基元） ───────────── */

/** roleCard → AgentTeams Agent */
export function toAgentTeamsAgent(card: RoleCard): ATAgent {
  return {
    agentId: card.id,
    name: card.name,
    role: card.role,
    description: `${card.goal}\n${card.backstory}`,
    capabilities: card.skills.map((s) => s.name),
    boundaries: {
      allowed: card.boundaries.allowed,
      forbidden: card.boundaries.forbidden,
      riskLevel: card.boundaries.riskLevel,
      requiresApproval: card.boundaries.requiresApproval,
    },
  };
}

/** 由一组角色卡组装 Team（默认用内置 4 卡） */
export function createTeam(teamId = 'agentcorp-core', cards: RoleCard[] = ROLE_CARDS): ATTeam {
  return {
    teamId,
    name: 'AgentCorp 核心团队',
    agents: cards.map(toAgentTeamsAgent),
    sharedContext: ['招聘需求', '面试转录', '雷达分', 'pass^k', '偏差审计', '决策理由'],
  };
}

/** 岗位类型（与评估中心 JobType 对齐） */
export type ATJobType = 'image' | 'text' | 'code';

/** 从招聘需求识别岗位类型（dispatcher 拆解依据之一）。 */
export function detectJobType(requirement: string): ATJobType {
  if (/图|画|设计|海报|视觉|插画/i.test(requirement)) return 'image';
  if (/文案|写作|翻译|摘要|文章|编辑/.test(requirement)) return 'text';
  return 'code';
}

/**
 * dispatcher 动态任务拆解（SP-06）：基于岗位类型 + RADAR_DIMS 生成拆解计划，
 * 替代旧版硬编码字符串——拆解随候选岗位变化。
 */
export function decomposeTask(input: { requirement: string }): {
  jobType: ATJobType;
  steps: string[];
} {
  const jobType = detectJobType(input.requirement);
  const dims = RADAR_DIMS.join('/');
  return {
    jobType,
    steps: [
      `recruiter:结构化面试（岗位类型=${jobType}，目标维度=${dims}）`,
      `evaluator:六维能力评估+pass^k可靠性审计（岗位类型=${jobType}，k=3，阈值=3.5）`,
      `boss:审批拍板（高风险动作需人工确认，沉淀结构化经验规则）`,
    ],
  };
}

/** 由招聘需求构造 Task（含 dispatcher 动态拆解，SP-06） */
export function createTask(input: {
  taskId?: string;
  title: string;
  requirement: string;
  candidateId: string;
  candidateName: string;
  transcript: string;
}): ATTask {
  return {
    taskId: input.taskId ?? `task-${input.candidateId}`,
    title: input.title,
    requirement: input.requirement,
    candidateId: input.candidateId,
    candidateName: input.candidateName,
    transcript: input.transcript,
    decomposition: decomposeTask(input).steps,
  };
}

/** 列出团队可调用的全部 Skill（SP-04）：注册表 ∩ 团队成员。 */
export function listTeamSkills(team: ATTeam): ATSkill[] {
  registerBuiltinSkills();
  const memberIds = new Set(team.agents.map((a) => a.agentId));
  const skills: ATSkill[] = [];
  for (const card of ROLE_CARDS) {
    if (!memberIds.has(card.id)) continue;
    for (const s of card.skills) {
      skills.push({
        skillId: s.id,
        name: s.name,
        ownerAgent: card.id,
        boundaries: {
          allowed: card.boundaries.allowed,
          forbidden: card.boundaries.forbidden,
          riskLevel: card.boundaries.riskLevel,
          requiresApproval: card.boundaries.requiresApproval,
        },
      });
    }
  }
  return skills;
}

/**
 * 以 AgentTeams 形态调用 Skill（SP-04）：
 * 查注册表 → 校验 ownerAgent 在团队内（能力边界）→ 执行 handler。
 * 失败不抛，统一返回 SkillResult（含降级语义）。
 */
export async function invokeSkill(
  team: ATTeam,
  skillId: string,
  args: Record<string, unknown> = {},
): Promise<SkillResult> {
  registerBuiltinSkills();
  const def = getSkill(skillId);
  if (!def) {
    return { ok: false, degraded: true, reason: `skill 未注册: ${skillId}` };
  }
  const owner = team.agents.find((a) => a.agentId === def.ownerAgent);
  if (!owner) {
    return {
      ok: false,
      degraded: true,
      reason: `skill ${skillId} 的 owner「${def.ownerAgent}」不在团队 ${team.teamId} 中，拒绝调用（能力边界）。`,
    };
  }
  return runSkill(skillId, args);
}

/* ───────────── runTask：经 invokeSkill 串联的协同执行 ───────────── */

export interface RunTaskOptions {
  /** 注入评委（默认 demoJudge：网关可用走真实评委，否则降级 mock） */
  judge?: JudgeFn;
  k?: number;
  threshold?: number;
  bossProfile?: BossProfile | null;
}

function stepStatus(phase: string, summary: string): 'ok' | 'warn' | 'blocked' {
  if (phase === 'approve' && (summary.includes('回滚') || summary.includes('不稳定'))) return 'blocked';
  if (phase === 'verify' && summary.includes('unstable=true')) return 'warn';
  if (phase === 'tool' && summary.includes('source=degraded')) return 'warn'; // 评委全失败的降级评估
  return 'ok';
}

/**
 * 运行 Task（SP-04）：逐阶段经 `invokeSkill` 调用团队 Skill，
 * 而非直连 judge——评审可在 run.steps 看到「Agent → Skill」的真实调用链。
 * 任一 Skill 降级不中断流程（失败处理约定），由后续阶段/兜底逻辑消化。
 */
export async function runTask(
  team: ATTeam,
  task: ATTask,
  opts: RunTaskOptions = {},
): Promise<ATRun> {
  const runId = `run-${task.taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const judge = opts.judge ?? demoJudge;
  const k = opts.k ?? 3;
  const threshold = opts.threshold ?? 3.5;

  const trace: LoopStep[] = [];
  const cardOf = (id: string): RoleCard => ROLE_CARD_BY_ID[id] ?? ROLE_CARD_BY_ID.dispatcher!;
  const push = (
    phase: LoopStep['phase'],
    agentId: string,
    summary: string,
    payload?: unknown,
    skill?: string,
  ) =>
    trace.push({
      phase,
      agentRole: cardOf(agentId).role,
      agentName: cardOf(agentId).name,
      skill,
      summary,
      payload,
      ts: Date.now(),
    });

  // ── input：boss 接收任务输入 ──
  push('input', 'boss', `老板接收招聘需求：${task.requirement.slice(0, 60)}…`);

  // ── decompose：dispatcher 动态拆解（SP-06：随岗位变化，非硬编码） ──
  const plan = {
    jobType: detectJobType(task.requirement),
    targetDims: [...RADAR_DIMS],
    steps: task.decomposition,
  };
  push(
    'decompose',
    'dispatcher',
    `编排主控拆解任务为 ${plan.steps.length} 步子任务（岗位类型=${plan.jobType}），目标维度=${plan.targetDims.join('/')}`,
    { ...plan, sharedContext: team.sharedContext },
  );

  // ── context：recruiter → agent_interview（SP-06：sharedContext 透传；SP-08：历史经验注入） ──
  const priorRule = latestRule(task.candidateId);
  const interviewRes = await invokeSkill(team, 'agent_interview', {
    candidateId: task.candidateId,
    candidateName: task.candidateName,
    transcript: task.transcript,
    sharedContext: team.sharedContext,
    priorExperience: priorRule ?? undefined, // 上一次沉淀的训练重点作为本轮追问提示
  });
  const interviewReport: InterviewReport = interviewRes.ok && interviewRes.data
    ? (interviewRes.data as InterviewReport)
    : {
        candidateId: task.candidateId,
        transcriptLen: task.transcript.length,
        targetDims: [...RADAR_DIMS],
        note: `agent_interview 降级（${interviewRes.reason ?? '未知原因'}），以原始转录快照交接。`,
      };
  push(
    'context',
    'recruiter',
    priorRule
      ? `${interviewReport.note}（已注入历史经验规则：训练重点=${priorRule.weakestDim}）`
      : interviewReport.note,
    {
      ...interviewReport,
      sharedContext: team.sharedContext,
      injectedRule: priorRule ?? undefined,
    },
    'agent_interview',
  );

  // ── tool：evaluator → capability_assessment（接收 recruiter 上下文 + sharedContext） ──
  const assessRes = await invokeSkill(team, 'capability_assessment', {
    candidateId: task.candidateId,
    transcript: task.transcript,
    k,
    judge,
    bossProfile: opts.bossProfile ?? null,
    interviewReport, // recruiter 的面试结论作为评估输入（上下文传递）
    sharedContext: team.sharedContext,
  });
  const DEGRADED_ASSESS: CapabilityAssessment = {
    radars: [],
    meanRadar: { task: 0, quality: 0, comm: 0, creativity: 0, reliability: 0, cost: 0 },
    verdict: null,
    confidence: 0,
    evidence: [],
    source: 'degraded',
  };
  const assess: CapabilityAssessment =
    (assessRes.data as CapabilityAssessment | undefined) ?? DEGRADED_ASSESS;
  push(
    'tool',
    'evaluator',
    `评估中心调用评委 ${assess.radars.length}/${k} 次成功（source=${assess.source}），逐维均值雷达已聚合`,
    { meanRadar: assess.meanRadar },
    'capability_assessment',
  );

  // ── verify：evaluator → reliability_audit（降级则本地复算） ──
  const auditRes = await invokeSkill(team, 'reliability_audit', {
    radars: assess.radars,
    threshold,
  });
  const audit: ReliabilityAudit = auditRes.ok && auditRes.data
    ? (auditRes.data as ReliabilityAudit)
    : {
        passK: passK(assess.radars, { k: assess.radars.length, threshold }),
        biasAudit: auditJudgeBias(assess.radars),
      };
  push(
    'verify',
    'evaluator',
    `pass^k(allPass=${audit.passK.allPass}, passRate=${audit.passK.passRate})；偏差审计 unstable=${audit.biasAudit.unstable}(maxSpread=${audit.biasAudit.maxSpread})`,
    { passK: audit.passK, biasAudit: audit.biasAudit },
    'reliability_audit',
  );

  // ── approve：boss → boss_review（降级则本地纯函数兜底同一语义） ──
  const reviewRes = await invokeSkill(team, 'boss_review', {
    evaluation: {
      passK: audit.passK,
      biasAudit: audit.biasAudit,
      verdict: assess.verdict,
      confidence: assess.confidence,
      meanRadar: assess.meanRadar,
      source: assess.source, // degraded 评估不沉淀经验规则（H3 防线）
    },
    candidateName: task.candidateName,
    candidateId: task.candidateId,
    sharedContext: team.sharedContext,
  });
  const review: BossReviewOutput = reviewRes.ok && reviewRes.data
    ? (reviewRes.data as BossReviewOutput)
    : bossReviewDecision({
        passK: audit.passK,
        biasAudit: audit.biasAudit,
        verdict: assess.verdict,
        confidence: assess.confidence,
        meanRadar: assess.meanRadar,
        candidateName: task.candidateName,
      });
  const reviewSource: 'boss_review' | 'fallback' = reviewRes.ok && reviewRes.data ? 'boss_review' : 'fallback';
  push(
    'approve',
    'boss',
    `老板决策：${review.action.toUpperCase()}。${review.reason}（需人工确认=${review.requiresHumanAck}，来源=${reviewSource}）`,
    { action: review.action, requiresHumanAck: review.requiresHumanAck, source: reviewSource },
    'boss_review',
  );

  // ── evidence：dispatcher 轨迹留痕 ──
  push('evidence', 'dispatcher', `已沉淀 ${trace.length} 步执行轨迹（Trace/Metrics），可供观测与复盘。`, {
    traceLen: trace.length,
  });

  // ── precipitate：boss 经验沉淀（boss_review 产出的结构化规则） ──
  push('precipitate', 'boss', review.precipitatedRule.rule, review.precipitatedRule, 'boss_review');

  const req: ClosedLoopRequest = {
    requirement: task.requirement,
    candidateId: task.candidateId,
    candidateName: task.candidateName,
    candidatePersona: '',
    transcript: task.transcript,
    k,
    threshold,
    judge,
  };
  const result: ClosedLoopResult = {
    request: req,
    plan,
    interviewReport,
    evaluation: {
      radars: assess.radars,
      meanRadar: assess.meanRadar,
      verdict: assess.verdict as Verdict | null,
      confidence: assess.confidence,
      passK: audit.passK,
      biasAudit: audit.biasAudit,
      source: assess.source,
    },
    bossDecision: {
      action: review.action as BossAction,
      reason: review.reason,
      approvedBy: 'boss',
      requiresHumanAck: review.requiresHumanAck,
      source: reviewSource,
    },
    precipitatedRule: review.precipitatedRule,
    experience: review.precipitatedRule.rule,
    trace,
  };

  return {
    runId,
    teamId: team.teamId,
    taskId: task.taskId,
    // M2：rollback 或评估整体降级（judge 全失败）都不算「completed」
    status: review.action === 'rollback' || assess.source === 'degraded' ? 'failed' : 'completed',
    steps: trace.map((s) => ({
      phase: s.phase,
      agent: s.agentName,
      skill: s.skill,
      summary: s.summary,
      status: stepStatus(s.phase, s.summary),
    })),
    result,
  };
}

export { ROLE_CARD_BY_ID };
