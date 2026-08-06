/**
 * src/services/judgeClient.ts
 * MiniCPM-o 外部裁判客户端（T07）。
 *
 * - evaluate(input)：经由 Host API 代理 POST http://127.0.0.1:3210/api/evaluate/run，
 *   解析 SSE 流为 EvaluationEvent（radar_update ×6 + verdict + done）。
 * - 非 200 / 503 / 网络错误时回退 fallbackMock：用 metricsEngine 客观 KPI
 *   归一化到 0–5，离线可用。
 *
 * 鉴权：Host API 需要 x-clawx-host-session 头（每会话随机 token），
 * 通过 renderer→main 的 ipc 'hostapi:token' 获取。
 */
import { invokeIpc } from '@/lib/api-client';
import type { EvaluationEvent, TelemetryEvent, RadarScore, RadarDim, Verdict } from '@/types/evaluation';
import type { ConvergenceScore, TurnState } from '@/types/convergence';
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
  preference?: {
    aesthetic?: string;
    budget_max?: number;
    weight?: Partial<Record<string, number>>;
  };
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
  };
}

/** 把 SSE 原始 JSON 解析成 ConvergenceScore（字段缺失时给安全默认值） */
function toConvergenceScore(json: Record<string, unknown>): ConvergenceScore {
  const weights = (json.weights ?? {}) as Record<string, unknown>;
  return {
    run_id: String(json.run_id ?? ''),
    agent_id: String(json.agent_id ?? ''),
    contraction_rate: Number(json.contraction_rate ?? 0),
    residual: Number(json.residual ?? 0),
    stability: Number(json.stability ?? 0),
    convergence_score: Number(json.convergence_score ?? 0),
    reversibility: Number(json.reversibility ?? 0),
    convergence_quality: json.convergence_quality === 1 ? 1 : 0,
    weights: {
      w1: Number(weights.w1 ?? 0),
      w2: Number(weights.w2 ?? 0),
      w3: Number(weights.w3 ?? 0),
    },
    ts: String(json.ts ?? new Date().toISOString()),
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

/** 将 usage 条目尽力转为 TelemetryEvent */
function usageToTelemetry(usage: TokenUsageHistoryEntryLike[]): TelemetryEvent[] {
  if (usage.length === 0) {
    return [
      {
        agent_id: 'unknown',
        task_id: 'unknown',
        success: true,
        first_try: true,
        rework: 0,
        latency_ms: 0,
        human_interventions: 0,
        escalations: 0,
        out_of_domain: false,
        ts: new Date().toISOString(),
      },
    ];
  }
  return usage.map<TelemetryEvent>((u) => ({
    agent_id: u.agentId,
    task_id: u.sessionId,
    success: true,
    first_try: true,
    rework: 0,
    latency_ms: 0,
    human_interventions: 0,
    escalations: 0,
    out_of_domain: false,
    ts: u.timestamp,
  }));
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
 * 离线回退：用 metricsEngine 的客观 KPI 归一化到 0–5，产出与真实裁判同构的事件流。
 * 不依赖网络。
 */
export async function* fallbackMock(input: JudgeRunInput): AsyncIterable<EvaluationEvent> {
  const telemetry = usageToTelemetry(input.usage);
  const kpi = computeKpi(telemetry, currentWindow());

  const totalCost = input.usage.reduce(
    (sum, u) => sum + (u.costUsd ?? ((u.totalTokens ?? 0) / 1000) * 0.01),
    0,
  );
  // 成本分：预算 1.0 USD 为基准，越低越高分
  const costScore = clamp(5 - (totalCost / 1.0) * 5, 0, 5);

  const radar: RadarScore = {
    task: clamp(kpi.task_completion_rate * 5, 0, 5),
    quality: clamp(kpi.autonomy_rate * 5, 0, 5),
    comm: clamp((1 - kpi.escalation_rate) * 5, 0, 5),
    creativity: clamp(kpi.cross_task_generalization * 5, 0, 5),
    reliability: clamp(((1 - kpi.rework_rate) + kpi.stability_consistency) * 2.5, 0, 5),
    cost: costScore,
  };

  const dims: Array<keyof RadarScore> = [
    'task',
    'quality',
    'comm',
    'creativity',
    'reliability',
    'cost',
  ];
  for (const dim of dims) {
    await sleep(120);
    yield {
      type: 'radar_update',
      dim,
      score: round1(radar[dim]),
      confidence: 0.8,
      evidence: `客观 KPI 归一化（${dim}）`,
    };
  }

  const avg = dims.reduce((s, d) => s + radar[d], 0) / dims.length;
  const verdict = avg >= 4 ? 'MVP' : avg >= 2.5 ? 'OBSERVE' : 'FIRED';
  const userFit = Math.round(avg * 20);

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
    evidence_trace: [
      `task_completion_rate=${(kpi.task_completion_rate * 100).toFixed(0)}%`,
      `autonomy_rate=${(kpi.autonomy_rate * 100).toFixed(0)}%`,
      `total_cost≈$${totalCost.toFixed(4)}`,
    ],
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

export const judgeClient = { evaluate, fallbackMock };
