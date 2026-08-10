/**
 * src/services/judgeClient.ts
 * MiniCPM-o 外部裁判客户端（T07）。
 *
 * - evaluate(input)：经由 Host API 代理 POST http://127.0.0.1:3210/api/evaluate/run，
 *   解析 SSE 流为 EvaluationEvent（radar_update ×6 + verdict + done）。
 * - 非 200 / 503 / 网络错误时回退 fallbackMock：cost 维由真实 usage 折算，
 *   其余维有真实遥测走 metricsEngine 客观 KPI、遥测退化走 agentId 哈希派生，离线可用。
 *
 * 鉴权：Host API 需要 x-clawx-host-session 头（每会话随机 token），
 * 通过 renderer→main 的 ipc 'hostapi:token' 获取。
 */
import { invokeIpc } from '@/lib/api-client';
import type {
  EvaluationEvent,
  TelemetryEvent,
  RadarScore,
  RadarDim,
  Verdict,
  BossProfile,
} from '@/types/evaluation';
import type { ConvergenceScore, TurnState } from '@/types/convergence';
import type {
  ArenaCompareInput,
  ArenaMatch,
  ArenaPickResult,
  ArenaUserPickInput,
} from '@/types/arena';
import { computeKpi } from '@/engine/metricsEngine';

// 与 src/lib/host-api.ts 保持一致
const HOST_API_PORT = 3210;
const HOST_API_BASE = `http://127.0.0.1:${HOST_API_PORT}`;
const SESSION_HEADER = 'x-clawx-host-session';

/** 一次裁判运行的入参（与后端 model-service /api/evaluate-run 契约严格对齐） */
export interface JudgeTask {
  title: string;
  description: string;
  weight: number;
}

export interface JudgeRunInput {
  agentId: string;
  agentName: string;
  persona?: string;
  task: JudgeTask;
  transcript: string;
  /** 真实 token 用量（来自 tokenUsageCollector） */
  usage: TokenUsageHistoryEntryLike[];
  /**
   * 真实逐任务遥测（可选，仅加法；后端 pydantic 默认忽略未知字段，
   * 与下方 convergence 字段同先例）。传入时 fallbackMock 的雷达由客观 KPI
   * 归一化派生；缺失/为空（遥测退化）时改由 agentId 确定性哈希派生，
   * 避免旧实现 usageToTelemetry 伪造全成功事件导致的六维失真。
   */
  telemetry?: TelemetryEvent[];
  preference?: {
    aesthetic?: string;
    budget_max?: number;
    weight?: Partial<Record<string, number>>;
  };
  /**
   * A · 老板原型（用户个性化）：描述「正在评估/雇佣这位 agent 的人」。
   * 与既有 agent.persona（agent 自己的系统人设）区分。后端不识别时忽略该字段；
   * 前端流式裁判当前未消费它，但 /api/chat-judge 路径（judgeChat）已据此注入前缀。
   */
  bossProfile?: BossProfile;
  /**
   * 收敛层开关（仅加法，后端不识别时忽略该字段）。
   * k = 每轮候选数（建议 3–7，保可逆性）；captureSummaries = 是否回传候选摘要文本。
   */
  convergence?: {
    k?: number;
    captureSummaries?: boolean;
  };
}

/* ───────────── 收敛层 SSE 侧信道（设计 §5.2，纯加法） ─────────────
 * `convergence_update` / `convergence_score` 不属于 EvaluationEvent 联合类型
 * （评估域契约保持不动），故走独立监听器分发，订阅方（convergenceStore）
 * 自行决定如何落到轨迹上。无人订阅时静默丢弃，不影响评估主流。 */

/** 收敛事件（判别联合） */
export type JudgeConvergenceEvent =
  | { type: 'convergence_update'; runId: string; turn: TurnState }
  | { type: 'convergence_score'; runId: string; score: ConvergenceScore };

type ConvergenceHandler = (event: JudgeConvergenceEvent) => void;

const convergenceHandlers = new Set<ConvergenceHandler>();

/**
 * 订阅收敛事件。
 * @returns 取消订阅函数
 */
export function onConvergenceEvent(handler: ConvergenceHandler): () => void {
  convergenceHandlers.add(handler);
  return () => {
    convergenceHandlers.delete(handler);
  };
}

/** 广播收敛事件（订阅方异常不影响其他订阅方与主流） */
function emitConvergence(event: JudgeConvergenceEvent): void {
  for (const handler of convergenceHandlers) {
    try {
      handler(event);
    } catch {
      // 订阅方自身异常吞掉
    }
  }
}

/** 把 SSE 原始 JSON 解析成 TurnState（字段缺失时给安全默认值） */
function toTurnState(json: Record<string, unknown>): TurnState {
  const rawCandidates = Array.isArray(json.candidates) ? (json.candidates as unknown[]) : [];
  return {
    turn: Number(json.turn ?? 0),
    candidates: rawCandidates.map((item) => {
      const c = (item ?? {}) as Record<string, unknown>;
      return {
        candidate_id: String(c.candidate_id ?? ''),
        turn: Number(c.turn ?? json.turn ?? 0),
        summary_text: String(c.summary_text ?? ''),
        embedding: Array.isArray(c.embedding) ? (c.embedding as unknown[]).map(Number) : [],
        job_type: c.job_type as TurnState['candidates'][number]['job_type'],
      };
    }),
    belief_embedding: Array.isArray(json.belief_embedding)
      ? (json.belief_embedding as unknown[]).map(Number)
      : [],
    // 08-07：透传诚实标注（旧版后端无此字段 → undefined，向后兼容）
    source: json.source === 'projected' || json.source === 'measured' ? json.source : undefined,
    synthetic: typeof json.synthetic === 'boolean' ? json.synthetic : undefined,
  };
}

/** 把 SSE 原始 JSON 解析成 ConvergenceScore（字段缺失时给安全默认值） */
function toConvergenceScore(json: Record<string, unknown>): ConvergenceScore {
  const weights = (json.weights ?? {}) as Record<string, unknown>;
  return {
    run_id: String(json.run_id ?? ''),
    agent_id: String(json.agent_id ?? ''),
    contraction_rate: Number(json.contraction_rate ?? 0),
    // A3：R/St 缺失或为 null 时保持 null（= 未获人类背书，未参与评分），
    // 不能落成 0 —— 0 会被读成「完美对齐」。
    residual: json.residual === null || json.residual === undefined ? null : Number(json.residual),
    stability:
      json.stability === null || json.stability === undefined ? null : Number(json.stability),
    // 语义收缩（SC）：走 A3 数值契约 —— 始终填数值（下游 toFixed/Number 不会崩），
    // 「没算过」与「一项未知都没消解」靠 semantic_scored 区分，不靠 null。
    // 旧版后端无此字段 → 0 + semantic_scored=false，UI 应显示「—」而非 0.000。
    semantic_contraction: Number(json.semantic_contraction ?? 0),
    // 是否真的参与了评分。下游必须读本字段判断，不许靠 semantic_contraction === 0
    // 反推 —— 0 是合法的「未消解」取值，两者不可混。
    semantic_scored: json.semantic_scored === true,
    // 诊断字段：S₀→S_K 的 unknowns 净变化，允许为负（负 = 探索中发现新未知，
    // 是真实信号不是错误）。缺失时 0 表示「无变化」，语义上安全。
    unknowns_delta: Number(json.unknowns_delta ?? 0),
    convergence_score: Number(json.convergence_score ?? 0),
    reversibility: Number(json.reversibility ?? 0),
    convergence_quality: json.convergence_quality === 1 ? 1 : 0,
    weights: {
      w1: Number(weights.w1 ?? 0),
      w2: Number(weights.w2 ?? 0),
      w3: Number(weights.w3 ?? 0),
    },
    ts: String(json.ts ?? new Date().toISOString()),
    // A2：source/synthetic 为必填。旧版后端不发这两个字段时，按最保守方向
    // 兜底为 projected/synthetic —— 未标注的数据不能默认当实测用，
    // 否则一条来路不明的分数会直接进榜单。
    source: json.source === 'measured' ? 'measured' : 'projected',
    synthetic: json.synthetic === false ? false : true,
    persisted: typeof json.persisted === 'boolean' ? json.persisted : undefined,
  };
}

/** 与 @electron/utils/token-usage-core TokenUsageHistoryEntry 结构对齐的轻量类型 */
export interface TokenUsageHistoryEntryLike {
  timestamp: string;
  sessionId: string;
  agentId: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 获取 Host API 会话 token（renderer → main ipc） */
async function getHostApiToken(): Promise<string> {
  try {
    return (await invokeIpc<string>('hostapi:token')) ?? '';
  } catch {
    return '';
  }
}

/**
 * agentId 确定性哈希（FNV-1a 32bit）。
 * 对齐 model-service evaluator._derive_run_radar 的「agent_id 哈希派生」思路：
 * 渲染层无 node:crypto，用自包含 FNV-1a 保证同 agentId 可复现、agent 间有区分度。
 */
function hashAgentId(agentId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) {
    h ^= agentId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 哈希抖动：base + [0,2) 的确定性偏移（对齐 _derive_run_radar 的 jitter） */
function jitter(h: number, shift: number, base: number): number {
  return base + (((h >>> shift) % 1000) / 1000) * 2;
}

/** 从 SSE 文本块解析单条 EvaluationEvent（容忍未知事件类型） */
function parseBlock(block: string): EvaluationEvent | null {
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      data += line.slice(5).replace(/^\s+/, '');
    }
  }
  if (!data) return null;
  try {
    const json = JSON.parse(data) as Record<string, unknown>;
    const type = json.type;
    if (type === 'radar_update') {
      return {
        type: 'radar_update',
        dim: json.dim as RadarDim,
        score: Number(json.score ?? 0),
        confidence: Number(json.confidence ?? 0),
        evidence: String(json.evidence ?? ''),
      } as EvaluationEvent;
    }
    if (type === 'narration') {
      return {
        type: 'narration',
        delta: String(json.delta ?? ''),
        is_final: Boolean(json.is_final),
      } as EvaluationEvent;
    }
    if (type === 'audio') {
      return {
        type: 'audio',
        chunk: String(json.chunk ?? ''),
        format: json.format === 'pcm16' ? 'pcm16' : 'wav',
        sample_rate: Number(json.sample_rate ?? 16000),
      } as EvaluationEvent;
    }
    if (type === 'verdict') {
      return {
        type: 'verdict',
        verdict: json.verdict as Verdict,
        user_fit: Number(json.user_fit ?? 0),
        evidence_trace: Array.isArray(json.evidence_trace)
          ? (json.evidence_trace as unknown[]).map(String)
          : [],
        confidence: Number(json.confidence ?? 0),
      } as EvaluationEvent;
    }
    if (type === 'done') {
      return { type: 'done', evaluation_id: String(json.evaluation_id ?? '') } as EvaluationEvent;
    }
    // 收敛层事件走侧信道，不进入 EvaluationEvent 主流
    if (type === 'convergence_update') {
      emitConvergence({
        type: 'convergence_update',
        runId: String(json.run_id ?? ''),
        turn: toTurnState(json),
      });
      return null;
    }
    if (type === 'convergence_score') {
      emitConvergence({
        type: 'convergence_score',
        runId: String(json.run_id ?? ''),
        score: toConvergenceScore(json),
      });
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 逐块解析 SSE 流，yield EvaluationEvent */
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<EvaluationEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseBlock(block);
      if (ev) yield ev;
    }
  }
  if (buffer.trim()) {
    const ev = parseBlock(buffer);
    if (ev) yield ev;
  }
}

/**
 * 调用 MiniCPM-o 裁判（Host API 代理）。任何失败回退 Mock。
 */
export async function* evaluate(input: JudgeRunInput): AsyncIterable<EvaluationEvent> {
  try {
    const token = await getHostApiToken();
    const res = await fetch(`${HOST_API_BASE}/api/evaluate/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SESSION_HEADER]: token,
      },
      body: JSON.stringify(input),
    });
    if (!res.ok || !res.body) {
      throw new Error(`judge responded ${res.status}`);
    }
    yield* parseSseStream(res.body);
  } catch {
    // 离线 / 503 / 网络错误：回退客观 KPI 归一化
    yield* fallbackMock(input);
  }
}

/**
 * 离线回退：产出与真实裁判同构的事件流，不依赖网络。
 * 雷达派生（08-07 诚实化修复）：
 * - cost 维始终由真实 usage 成本折算（预算 1.0 USD 为基准，越低越高分）；
 * - 有真实遥测（input.telemetry 非空）时，其余五维走 metricsEngine 客观 KPI 归一化；
 * - 遥测退化（无真实事件）时，其余五维由 agentId 确定性哈希派生
 *   （对齐 model-service evaluator._derive_run_radar）——不伪造完美 KPI，
 *   保证可复现、agent 间有区分度、FIRED 可达。
 */
export async function* fallbackMock(input: JudgeRunInput): AsyncIterable<EvaluationEvent> {
  const totalCost = input.usage.reduce(
    (sum, u) => sum + (u.costUsd ?? ((u.totalTokens ?? 0) / 1000) * 0.01),
    0,
  );
  const costScore = clamp(5 - (totalCost / 1.0) * 5, 0, 5);

  const hasTelemetry = (input.telemetry?.length ?? 0) > 0;
  const kpi = hasTelemetry ? computeKpi(input.telemetry ?? [], currentWindow()) : null;

  let radar: RadarScore;
  if (kpi) {
    // 真实遥测路径：客观 KPI 归一化到 0–5
    radar = {
      task: clamp(kpi.task_completion_rate * 5, 0, 5),
      quality: clamp(kpi.autonomy_rate * 5, 0, 5),
      comm: clamp((1 - kpi.escalation_rate) * 5, 0, 5),
      creativity: clamp(kpi.cross_task_generalization * 5, 0, 5),
      reliability: clamp(((1 - kpi.rework_rate) + kpi.stability_consistency) * 2.5, 0, 5),
      cost: costScore,
    };
  } else {
    // 遥测退化路径：agentId 哈希派生（确定性，可复现）
    const h = hashAgentId(input.agentId);
    radar = {
      task: clamp(jitter(h, 0, 3.0), 0, 5),
      quality: clamp(jitter(h, 3, 3.0), 0, 5),
      comm: clamp(jitter(h, 6, 2.5), 0, 5),
      creativity: clamp(jitter(h, 9, 2.5), 0, 5),
      reliability: clamp(jitter(h, 12, 3.0), 0, 5),
      cost: costScore,
    };
  }

  const dims: Array<keyof RadarScore> = [
    'task',
    'quality',
    'comm',
    'creativity',
    'reliability',
    'cost',
  ];
  const dimEvidence = kpi
    ? (dim: keyof RadarScore) => `客观 KPI 归一化（${dim}）`
    : (dim: keyof RadarScore) =>
        dim === 'cost' ? '真实 usage 成本折算' : `${dim} 由 agentId 哈希派生（mock 回退）`;
  for (const dim of dims) {
    await sleep(120);
    yield {
      type: 'radar_update',
      dim,
      score: round1(radar[dim]),
      confidence: 0.8,
      evidence: dimEvidence(dim),
    };
  }

  const avg = dims.reduce((s, d) => s + radar[d], 0) / dims.length;
  const verdict = avg >= 4 ? 'MVP' : avg >= 2.5 ? 'OBSERVE' : 'FIRED';
  const userFit = Math.round(avg * 20);
  // 证据留痕：真实遥测路径给客观 KPI；哈希路径诚实标注派生来源（对齐 model-service mock）
  const evidenceTrace = kpi
    ? [
        `task_completion_rate=${(kpi.task_completion_rate * 100).toFixed(0)}%`,
        `autonomy_rate=${(kpi.autonomy_rate * 100).toFixed(0)}%`,
        `total_cost≈$${totalCost.toFixed(4)}`,
      ]
    : [
        `total_cost≈$${totalCost.toFixed(4)}`,
        `avg_radar=${avg.toFixed(2)}`,
        'source=mock（遥测退化，agentId 哈希派生）',
      ];

  // 讲解文本（离线语音闭环：narration 由渲染层直接 TTS 播报）
  const DIM_LABELS: Record<keyof RadarScore, string> = {
    task: '任务完成',
    quality: '产出质量',
    comm: '沟通协作',
    creativity: '创造泛化',
    reliability: '稳定可靠',
    cost: '性价比',
  };
  const strongest = dims.reduce((a, b) => (radar[a] >= radar[b] ? a : b));
  const weakest = dims.reduce((a, b) => (radar[a] <= radar[b] ? a : b));
  const verdictLabel = verdict === 'MVP' ? 'MVP' : verdict === 'OBSERVE' ? '待观察' : 'You are fired';
  const narrationLines = [
    `${input.agentName ?? input.agentId} 的六维评估已完成。`,
    `最强维度是${DIM_LABELS[strongest]}（${radar[strongest].toFixed(1)} 分），最弱维度是${DIM_LABELS[weakest]}（${radar[weakest].toFixed(1)} 分）。`,
    `综合判定为${verdictLabel}。`,
  ];
  for (const line of narrationLines) {
    await sleep(120);
    yield { type: 'narration', delta: line, is_final: false };
  }
  yield { type: 'narration', delta: '', is_final: true };

  await sleep(150);
  yield {
    type: 'verdict',
    verdict,
    user_fit: userFit,
    evidence_trace: evidenceTrace,
    confidence: 0.8,
  };

  await sleep(100);
  yield { type: 'done', evaluation_id: `mock-${input.agentId}-${Date.now()}` };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function currentWindow(): string {
  const d = new Date();
  const oneJan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - oneJan.getTime()) / 86_400_000 + oneJan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 对话逐轮/整段评分结果（C：live 面试证据 → 模型评测） */
export interface ChatJudgeResult {
  /** judge = 模型评测；degraded = 启发式降级（前端应据此决定展示优先级） */
  source: 'judge' | 'degraded';
  radar: RadarScore | null;
  verdict?: Verdict;
  confidence: number;
  evidence_trace: string[];
}

/**
 * A · 构建老板原型前缀（SP-Profile 等价物，纯函数可单测）。
 * 把 BossProfile 翻译成裁判 prompt 的「评估上下文」段落，使裁判在
 * 「与这样一位老板协作」的视角下评估 Agent 行为（Wang 的个性化评估主张）。
 * 中性老板（id='neutral'）或无画像 → 返回空串（不污染离线基线评估）。
 */
export function buildPersonaPreamble(profile: BossProfile | null | undefined): string {
  if (!profile || profile.id === 'neutral') return '';
  const lines: string[] = [
    '[评估上下文 · 老板原型]',
    '你是正在评估这位 AI Agent 的「老板」。请基于「与这样一位老板协作」的视角，评估 Agent 在上述对话中的表现——尤其是它是否对齐该老板的沟通风格、是否在约束下做出合理取舍、是否在风险情境下稳健。',
  ];
  if (profile.name) lines.push(`- 原型名：${profile.name}`);
  if (profile.domain) lines.push(`- 领域：${profile.domain}`);
  if (profile.experienceLevel) lines.push(`- 经验水平：${profile.experienceLevel}`);
  if (profile.riskAversion) lines.push(`- 风险偏好：${profile.riskAversion}`);
  if (profile.communicationStyle) lines.push(`- 沟通风格：${profile.communicationStyle}`);
  if (profile.constraintPrefs?.length) lines.push(`- 约束偏好：${profile.constraintPrefs.join('、')}`);
  return lines.join('\n');
}

/**
 * 调用模型裁判对一段面试 transcript 评分（C 挂载点）。
 * 经 Host API 代理 POST /api/chat-judge；任何失败返回 null（调用方回退正则启发式）。
 * persona 非空时，自动在前缀注入老板原型上下文（不改后端字段名，向后兼容）。
 */
export async function judgeChat(
  agentId: string,
  transcript: string,
  persona?: BossProfile | null,
): Promise<ChatJudgeResult | null> {
  try {
    const preamble = buildPersonaPreamble(persona);
    const fullTranscript = preamble ? `${preamble}\n\n${transcript}` : transcript;
    const token = await getHostApiToken();
    const res = await fetch(`${HOST_API_BASE}/api/chat-judge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SESSION_HEADER]: token,
      },
      body: JSON.stringify({ agent_id: agentId, transcript: fullTranscript }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    const radar = json.radar;
    return {
      source: json.source === 'judge' ? 'judge' : 'degraded',
      radar: radar && typeof radar === 'object' ? (radar as RadarScore) : null,
      verdict: json.verdict as Verdict | undefined,
      confidence: Number(json.confidence ?? 0),
      evidence_trace: Array.isArray(json.evidence_trace)
        ? (json.evidence_trace as unknown[]).map(String)
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Arena 个性化对决：POST /api/arena/compare（T03）。
 * 经 Host API 代理（127.0.0.1:3210）转发至 model-service；任何失败返回 null，
 * 调用方（arenaStore）据此展示降级提示（后端不可用 / 网络错误）。
 */
export async function arenaCompare(input: ArenaCompareInput): Promise<ArenaMatch | null> {
  try {
    const token = await getHostApiToken();
    const res = await fetch(`${HOST_API_BASE}/api/arena/compare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SESSION_HEADER]: token,
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    return (await res.json()) as ArenaMatch;
  } catch {
    return null;
  }
}

/**
 * Arena 用户主观选择：POST /api/arena/user-pick（T03）。
 * 经 Host API 代理转发至 model-service；任何失败返回 null。
 */
export async function arenaUserPick(input: ArenaUserPickInput): Promise<ArenaPickResult | null> {
  try {
    const token = await getHostApiToken();
    const res = await fetch(`${HOST_API_BASE}/api/arena/user-pick`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SESSION_HEADER]: token,
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    return (await res.json()) as ArenaPickResult;
  } catch {
    return null;
  }
}

export const judgeClient = { evaluate, fallbackMock, judgeChat, arenaCompare, arenaUserPick };