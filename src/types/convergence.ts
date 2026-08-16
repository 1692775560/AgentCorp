/**
 * src/types/convergence.ts
 * Layer3 收敛层数据模型契约（T13，前端镜像，严格对齐
 * model-service/app/scoring/convergence.py 的 Pydantic 模型与 §5.1）。
 *
 * 设计红线：Layer3 新增字段全部独立命名空间（conv_ 意念），
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

/** 单个待消解的未知项（semantic_contraction 输入） */
export interface Unknown {
  /** 稳定 id（跨轮追踪同一未知项，措辞变化不影响判定） */
  uid: string;
  /** 人类可读描述 */
  text: string;
  /** 预留，本期不进权重 */
  severity?: 'low' | 'mid' | 'high';
}

/** 单轮状态（候选集 + agent 的 belief embedding） */
export interface TurnState {
  turn: number;
  /** 该轮候选（建议 3–7，保可逆性） */
  candidates: CandidateEmbedding[];
  /** agent "它以为你要什么" 的 embedding */
  belief_embedding: number[];
  /**
   * 该轮尚未消解的未知项快照（全量非增量）。
   * 旧版后端无此字段（undefined）；空/缺失 → SC 判「没算」而非满分。
   */
  unknowns?: Unknown[];
  /** 若该轮人类已置顶则记来源 */
  human_signal?: ConvSource;
  /**
   * 轨迹来源标注（08-07 加固）：MVP 阶段 /api/evaluate-run 侧信道发的是
   * 服务端确定性投影数据（'projected' + synthetic=true），非实测。
   * 旧版后端无此字段（undefined），消费方按实测兼容处理。
   */
  source?: 'projected' | 'measured';
  /** true = 合成数据（投影演示），非实测轨迹 */
  synthetic?: boolean;
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
  /**
   * 被人类背书候选的 candidate_id。
   *
   * 命名说明（A1）：旧名 human_anchor_id 会被读成 HumanAnchor.anchor_id，
   * 但引擎全程按 candidate_id 语义使用它（在候选集里查 embedding），
   * 拿它去 get_anchor 恒为 null。改名以消除这个歧义。
   */
  anchor_candidate_id?: string;
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
  /** explicit_pin（MVP）/ dual_leaderboard_drag */
  source: ConvSource;
  ts: string;
}

/** 收敛评分结果 */
export interface ConvergenceScore {
  run_id: string;
  agent_id: string;
  /** CR ∈[0,1] */
  contraction_rate: number;
  /**
   * R ∈[0,1]（越小越好）。
   *
   * null = 未获人类背书，该项未参与评分（A3）。
   * 不能用 0 代替：0 在语义上等于「完美对齐」，与「没算」无法区分，
   * 下游只要不查 convergence_quality 就会把未背书读成满分。
   */
  residual: number | null;
  /** St ∈[0,1]；null 含义同 residual */
  stability: number | null;
  /**
   * SC ∈[0,1]：unknowns 缩减率（语义收敛）。
   *
   * 未计算时后端填 0.0（保数值契约，toFixed / Number 不崩），
   * 「没算」与「一项未知都没消解」必须靠 semantic_scored 区分。
   * 禁止用 `?? 0` / `|| 0` 判断有效性 —— 隐式契约会被某个 or 吃掉。
   */
  semantic_contraction: number;
  /** SC 是否真的参与评分。false 时 UI 显示「—」而非 0.000 */
  semantic_scored: boolean;
  /**
   * |U_K| − |U_0|，允许负数，纯诊断不进权重。
   * 负 = 未知项减少（收敛）；正 = 探索中发现新未知（真实信号，不是错误）。
   */
  unknowns_delta: number;
  /** 0–100 = 100·(w1·CR + w2·(1−R) + w3·St) */
  convergence_score: number;
  /** Rev ∈[0,1]（防越权） */
  reversibility: number;
  /** CQ（是否获人类背书，0|1） */
  convergence_quality: 0 | 1;
  weights: { w1: number; w2: number; w3: number };
  ts: string;
  /**
   * 数据来源，由产出方（引擎）显式标注，不由下游推断（A2）。
   * 'projected' = 确定性投影的演示数据；'measured' = 真实模型编码。
   */
  source: 'projected' | 'measured';
  /** true = 合成数据（投影演示），不得进入任何对外榜单（A2） */
  synthetic: boolean;
  /** 服务端落盘是否成功（false = 持久化失败，显式暴露不再静默） */
  persisted?: boolean;
}

/** Layer3 SSE 事件类型（对齐 serve.py §5.2 约定） */
export type ConvergenceEventType = 'convergence_update' | 'convergence_score';
