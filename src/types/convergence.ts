/**
 * src/types/convergence.ts
 * Layer3 收敛层数据模型契约（T13，前端镜像，严格对齐
 * model-service/app/scoring/convergence.py 的 Pydantic 模型与 §5.1）。
 *
 * 设计红线（架构 §0）：Layer3 新增字段全部独立命名空间（conv_ 意念），
 * 不占用雷达/RADAR_DIMS/StageScore/DualLeaderboard/KpiRecord/RoiSnapshot 既有键。
 *
 * 序列化口径：后端 `model_dump(mode="json")` 默认输出 snake_case（与
 * evaluation.ts 既有契约一致），故前端统一消费 snake_case 字段名。
 * ConvSource / JobType / StageKey 直接复用既有类型，不重复定义。
 */
import type { JobType, StageKey } from './evaluation';

/** 锚点来源（MVP 先用 explicit_pin；批次 2 落地后回填 dual_leaderboard_drag） */
export type ConvSource = 'explicit_pin' | 'dual_leaderboard_drag';

/** 单候选的潜在 embedding（每轮 agent 产出） */
export interface CandidateEmbedding {
  candidate_id: string;
  /** 0 = S₀（初始），1..K */
  turn: number;
  /** "需求理解摘要" 原文 */
  summary_text: string;
  /** 编码器输出（默认确定性投影 d=64） */
  embedding: number[];
  /** 复用既有 JobType（image/text/code） */
  job_type: JobType;
}

/** 单轮状态（候选集 + agent 的 belief embedding） */
export interface TurnState {
  turn: number;
  /** 该轮候选（建议 3–7，保可逆性） */
  candidates: CandidateEmbedding[];
  /** agent "它以为你要什么" 的 embedding */
  belief_embedding: number[];
  /** 若该轮人类已置顶则记来源 */
  human_signal?: ConvSource;
}

/** 收敛轨迹（一次评估运行的完整记录） */
export interface ConvergenceTrace {
  run_id: string;
  agent_id: string;
  job_type: JobType;
  /** 可选关联到 S1/S2/S3 */
  stage?: StageKey;
  /** 默认 3，可配置 */
  k: number;
  /** 含 turn=0 的 S₀ */
  turns: TurnState[];
  /** 指向 HumanAnchor（被拖拽置顶候选的 candidate_id） */
  human_anchor_id?: string;
  /** owner id */
  created_by: string;
  /** ISO8601 UTC */
  ts: string;
}

/** 人类锚点（人即梯度源的落点） */
export interface HumanAnchor {
  anchor_id: string;
  /** 被背书的候选 */
  candidate_id: string;
  /** 锚点 embedding */
  embedding: number[];
  owner_id: string;
  /** explicit_pin（MVP）/ dual_leaderboard_drag（批次 2 后） */
  source: ConvSource;
  ts: string;
}

/** 收敛评分结果（对齐架构 §5.1 ConvergenceScore） */
export interface ConvergenceScore {
  run_id: string;
  agent_id: string;
  /** CR ∈[0,1] */
  contraction_rate: number;
  /** R ∈[0,1]（越小越好） */
  residual: number;
  /** St ∈[0,1] */
  stability: number;
  /** 0–100 = 100·(w1·CR + w2·(1−R) + w3·St) */
  convergence_score: number;
  /** Rev ∈[0,1]（防越权） */
  reversibility: number;
  /** CQ（是否获人类背书，0|1） */
  convergence_quality: 0 | 1;
  weights: { w1: number; w2: number; w3: number };
  ts: string;
}

/** Layer3 SSE 事件类型（对齐 serve.py §5.2 约定） */
export type ConvergenceEventType = 'convergence_update' | 'convergence_score';
