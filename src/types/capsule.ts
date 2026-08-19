/**
 * src/types/capsule.ts
 * 经验胶囊（Experience Capsule）契约类型。
 *
 * 一次「用户 × Agent × 真实任务」的协作完成后，系统把这次协作沉淀为
 * 一颗可复用的胶囊——既作回归集（生产面试回流），也作后续 Agent 适配
 * 与群体经验共享的原子单位。
 *
 * 设计纪律：
 * - **不存交付物全文**：只存摘要（前 200 字 + 长度），控制体积与隐私面。
 * - **六维快照而非历史**：只留本次评测的 radarLatest，历史在 EvaluationProfile 侧。
 * - **best-effort**：任何字段缺失都用 null/undefined，不编造。
 * - **schemaVersion**：向后兼容未来字段演进。
 */
import type { JobType, RadarScore } from './evaluation';

export interface ExperienceCapsule {
  /** 胶囊 ID（时间戳 + 随机后缀，不依赖 uuid 库） */
  capsuleId: string;
  /** 沉淀时间 ISO8601 UTC */
  createdAt: string;
  /** 任务标识 */
  taskId: string;
  taskTitle: string;
  /** 任务描述摘要（前 120 字），不存全文 */
  taskDescriptionDigest?: string | null;
  /** Agent 标识 */
  agentId: string;
  agentName: string;
  /** 工种（评测档案侧；缺失为 null） */
  jobType?: JobType | null;
  /** 本次评测的六维快照（EvaluationProfile.radarLatest） */
  radar: RadarScore | null;
  /** 用户契合度 0–100（EvaluationProfile.userFitLatest） */
  userFit?: number | null;
  /** 返工轮数（过程记录） */
  reworkRounds?: number;
  /** 是否通过验收（过程记录） */
  approved?: boolean | null;
  /** 交付物长度（字符数） */
  outputLength: number;
  /** 交付物摘要（前 200 字） */
  outputDigest: string;
  /** 关联评估运行 ID（与 trace runId 对齐） */
  runId?: string | null;
  /** 关联会话 ID */
  sessionId?: string | null;
  /** 人的判断（由 approved 派生：approved→approved, !approved→rejected, 未知→neutral） */
  humanJudgment?: 'approved' | 'rejected' | 'neutral' | null;
  /** 关联的根会话 ID（用于回溯 trace，可选） */
  rootSessionId?: string | null;
  /** schema 版本（向后兼容） */
  schemaVersion: 1;
}

/** 检索条件：按工种 / agentId / 验收结果过滤 */
export interface CapsuleQuery {
  jobType?: JobType | null;
  agentId?: string;
  approved?: boolean;
  /** 最多返回条数（默认 20） */
  limit?: number;
}
