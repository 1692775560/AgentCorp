/**
 * src/types/evaluation.ts
 * ★ AgentCorp 评估层单一类型真相源（Single Source of Truth）。
 *
 * 移植自原 Web Demo 的 src/types/index.ts，作为 AgentCorp（基于 ClawCorp 基底）
 * 评估层的契约根。前端 TS 与后端 `model-service/app/schemas.py`（待扩展）严格镜像。
 *
 * 关键契约：
 * - EvaluationRequest：评估请求（候选媒体以 URL 或 base64 提供）。
 * - EvaluationEvent：SSE 事件流联合类型，五种事件
 *   radar_update / narration / audio / verdict / done。
 *
 * 注：ClawCorp 基底的 src/types 下无 index.ts，评估类型统一收敛到此文件，
 * 其余领域类型见 src/types/agent.ts 等。
 */

/** 六维雷达维度键（顺序即展示顺序） */
export type RadarDim =
  | "task"
  | "quality"
  | "comm"
  | "creativity"
  | "reliability"
  | "cost";

/** 宣判结果枚举（大写，命名约定 §8） */
export type Verdict = "MVP" | "OBSERVE" | "FIRED";

/** 审美取向枚举 */
export type Aesthetic = "minimal" | "rich" | "neutral";

/** 六维分数（0–5，0.5 步进） */
export interface RadarScore {
  task: number;
  quality: number;
  comm: number;
  creativity: number;
  reliability: number;
  cost: number;
}

/** 六维权重（Σ=1） */
export interface WeightVector {
  task: number;
  quality: number;
  comm: number;
  creativity: number;
  reliability: number;
  cost: number;
}

/** 用户偏好（语音/表单解析所得） */
export interface UserPreference {
  aesthetic: Aesthetic;
  budget_max: number;
  preferred_stack: string[];
  weight: WeightVector;
}

/** 文本 persona 引用 */
export interface PersonaText {
  type: "text/markdown";
  content: string;
}

/** 媒体引用（URL 或 base64 内联） */
export interface MediaRef {
  type: string;
  url: string;
}

/** 代码库引用 */
export interface CodeRef {
  type: "application/zip" | "repo/github";
  url: string;
  lang: string;
}

/** 评估结果（模型生成） */
export interface Evaluation {
  radar: RadarScore;
  user_fit: number;
  verdict: Verdict;
  evidence_trace: string[];
  confidence: number;
}

/** 候选档案（前后端同源契约，见 PRD §6） */
export interface CandidateProfile {
  id: string;
  name: string;
  declared_tags: string[];
  declared_budget: number;
  persona_text: PersonaText;
  video_demo: MediaRef;
  voice_intro: MediaRef;
  artwork: MediaRef[];
  code_repo: CodeRef;
  evaluation: Evaluation;
}

/** 评估请求（options 用于复现控制，见架构 D7） */
export interface EvaluationRequest {
  candidate: CandidateProfile;
  preference: UserPreference;
  options?: {
    temperature?: number;
    seed?: number;
    frame_sample?: number;
  };
}

/* ===================== SSE 事件流（五种事件） ===================== */

/** 雷达逐维点亮（消费后触发动画） */
export interface RadarUpdateEvent {
  type: "radar_update";
  dim: RadarDim;
  score: number;
  confidence: number;
  evidence: string;
}

/** 讲解文本增量（is_final=true 表示讲解结束） */
export interface NarrationEvent {
  type: "narration";
  delta: string;
  is_final: boolean;
}

/**
 * 语音音频块。
 * chunk 始终为 base64 字符串：
 * - 真实模式：PCM16 / wav 字节（由 useSpeech 解码为 AudioBuffer 播放）。
 * - Mock 模式：UTF-8 文本（由 useSpeech 解码为文本后用 speechSynthesis 朗读）。
 * 两种模式复用同一字段，前端无感（架构 §8）。
 */
export interface AudioEvent {
  type: "audio";
  chunk: string;
  format: "pcm16" | "wav";
  sample_rate: number;
}

/** 终审判定（含 user_fit 与证据留痕） */
export interface VerdictEvent {
  type: "verdict";
  verdict: Verdict;
  user_fit: number;
  evidence_trace: string[];
  confidence: number;
}

/** 评估完成 */
export interface DoneEvent {
  type: "done";
  evaluation_id: string;
}

/** SSE 事件联合类型（前端统一解析） */
export type EvaluationEvent =
  | RadarUpdateEvent
  | NarrationEvent
  | AudioEvent
  | VerdictEvent
  | DoneEvent;

/** 评估会话状态机（架构 §8：idle → streaming → done） */
export type SessionStatus = "idle" | "streaming" | "done";

/** 运行时评估会话（存于 Zustand store） */
export interface EvaluationSession {
  candidate: CandidateProfile | null;
  preference: UserPreference | null;
  partialRadar: Partial<RadarScore>;
  dimEvidence: Partial<Record<RadarDim, string>>;
  narration: string;
  verdict: Verdict | null;
  userFit: number | null;
  evidenceTrace: string[];
  confidence: number | null;
}

/** 上传表单（P1 交互上传模式） */
export interface UploadForm {
  name: string;
  declared_tags: string[];
  declared_budget: number;
  persona_text: string;
  files: Record<string, File>;
}

/* ===================== 职场生命周期（阶段 A · 绩效中心） ===================== */

/**
 * 生命周期五态（架构 §4.2 / 评估设计 §4）。
 * 注意：agent 运行时真相为小写 `AgentLifecycleStatus`
 * （见 src/lib/evaluation/lifecycle.ts），此处大写 `LifecycleState` 为评估层内部别名，
 * 二者通过 evaluationAdapter.applyVerdict 统一映射。
 */
export type LifecycleState =
  | "ONBOARDING"
  | "ACTIVE"
  | "TRAINING"
  | "MAINTENANCE"
  | "RETIRED";

/** 可量化绩效指标 KPI（客观，聚合自运行遥测，见评估设计 §2.3） */
export interface KpiRecord {
  agentId: string;
  task_completion_rate: number; // TCR  0–1 任务完成率
  first_success_rate: number; // FSR  0–1 一次成功率
  rework_rate: number; // RR   0–1 返工率
  avg_delivery_latency_ms: number; // ADL  平均交付时延（ms）
  autonomy_rate: number; // AR   0–1 自主完成率
  escalation_rate: number; // ER   0–1 升级/求助率
  cross_task_generalization: number; // CGR  0–1 跨任务泛化率
  stability_consistency: number; // SCR  0–1 稳定性（多轮一致率）
  sample_n: number; // 参与聚合的遥测条数
  window: string; // 考核窗口，如 "2025-W30"
  computedAt: string; // ISO8601 UTC
}

/** ROI / 效率快照（见评估设计 §3） */
export interface RoiSnapshot {
  agentId: string;
  cost_total: number; // C_total 成本当量 CU
  value_total: number; // V_total 价值当量 CU
  roi: number; // (V−C)/C，可为负
  ipr: number; // V/C 投入产出比
  srpc: number; // 单位成本成功率 = n_success / C
  cost_perf_score: number; // 0–5 性价比分（CPS 与雷达 cost 维融合）
  roi_index: number; // 相对基线 ROI_baseline
  roi_norm?: number; // 群体 z-score（有对照群时填充）
  window: string;
}

/** 生命周期触发事件类型（驱动状态机迁移） */
export type LifecycleTrigger =
  | "probation_pass"
  | "probation_fail"
  | "monthly_arena"
  | "pip_pass"
  | "pip_fail"
  | "roi_drop"
  | "replaced"
  | "manual";

/** 生命周期迁移事件（可语音播报 reason） */
export interface LifecycleEvent {
  agentId: string;
  from: LifecycleState;
  to: LifecycleState;
  reason: string; // 人类可读触发原因
  trigger: LifecycleTrigger;
  ts: string; // ISO8601 UTC
}

/** 擂台排名层级（含末位淘汰标记） */
export type LeaderboardTier = "MVP" | "NORMAL" | "BOTTOM";

/** 擂台排名条目 */
export interface LeaderboardEntry {
  agentId: string;
  name: string;
  rank: number; // 名次（1=榜首）
  user_fit: number; // 0–100 用户契合度
  roi_norm: number; // z-score，末位判定依据
  state: LifecycleState;
  tier: LeaderboardTier; // MVP / NORMAL / BOTTOM
  radar_delta?: number; // 能力增长轨迹（晋升依据）
}

/* ===================== 运行期遥测（第二条契约，评估设计 §1.3） ===================== */

/** 朋友模型层回传的逐任务遥测（阶段 A 由 telemetrySynth 确定性合成） */
export interface TelemetryEvent {
  agent_id: string;
  task_id: string;
  success: boolean; // 任务是否成功
  first_try: boolean; // 是否一次成功
  rework: number; // 返工次数
  latency_ms: number; // 交付时延
  human_interventions: number; // 人工介入次数
  escalations: number; // 升级/求助次数
  out_of_domain: boolean; // 是否跨域（泛化）任务
  ts: string; // ISO8601 UTC
}
