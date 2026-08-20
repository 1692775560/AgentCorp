/**
 * src/types/public-capsule.ts
 * 群体经验共享的脱敏胶囊契约。
 *
 * 设计理念（用户战略阐述）：
 * AgentCorp 本地端把数据保留在用户本地（越用越聪明、人机越贴合、
 * 用户职场画像越清晰），但单用户数据无法进化 HR 题库 / benchmark /
 * 评估中心。群体经验共享把本地胶囊脱敏后跨用户共享，让：
 *   - 后来者选 Agent 时能借鉴相似工作流的群体经验（抖音式猜你喜欢）
 *   - 群体数据回流进化评测体系（题库/benchmark/评估中心智能化）
 *
 * 脱敏纪律（一票否决级）：
 * - **去掉一切可能含个人/企业隐私的内容字段**：taskTitle、
 *   taskDescriptionDigest、outputDigest、sessionId、sessionKey、rootSessionId
 *   全部不进 PublicCapsule。
 * - **只保留评测信号**：jobType、radar（六维已是去个人化的能力画像）、
 *   agentId（候选标识，非用户标识）、userFit、reworkRounds、approved、
 *   humanJudgment、createdAt、schemaVersion。
 * - **客户端标识脱敏**：sourceClient 是非可逆 hash（见 publicDigest.ts），
 *   用于去重/信誉而不暴露用户身份。
 *
 * 这是「开源框架 + 群体共享」的数据原子：脱敏后才可离开用户本地。
 */
import type { JobType, RadarScore } from './evaluation';

export interface PublicCapsule {
  /** 胶囊 ID（与本地 ExperienceCapsule.capsuleId 一致，用于去重） */
  capsuleId: string;
  /** 沉淀时间 ISO8601 UTC */
  createdAt: string;
  /** 工种（image/text/code）—— 评测信号，非个人标识 */
  jobType?: JobType | null;
  /** 六维快照（去个人化的能力画像） */
  radar: RadarScore | null;
  /** Agent 标识（templateId 或 agentId，候选侧非用户侧） */
  agentId: string;
  /** 用户契合度 0–100 */
  userFit?: number | null;
  /** 返工轮数 */
  reworkRounds?: number;
  /** 是否通过验收 */
  approved?: boolean | null;
  /** 人的判断三态 */
  humanJudgment?: 'approved' | 'rejected' | 'neutral' | null;
  /** 脱敏客户端标识（非可逆 hash，用于去重/信誉） */
  sourceClientHash?: string | null;
  /** 产生胶囊的应用版本（用于兼容性过滤） */
  appVersion?: string | null;
  /** schema 版本 */
  schemaVersion: 1;
}

/** 群体共享包：可序列化的胶囊集合文件格式 */
export interface PublicCapsulePackage {
  /** 包格式标识 */
  kind: 'agentcorp-public-capsules';
  /** 包 schema 版本 */
  schemaVersion: 1;
  /** 生成时间 */
  exportedAt: string;
  /** 胶囊列表 */
  capsules: PublicCapsule[];
  /** 来源标注（社区/版本等，非个人标识） */
  source?: string | null;
}

/** 群体胶囊检索条件 */
export interface PublicCapsuleQuery {
  jobType?: JobType | null;
  agentId?: string;
  approved?: boolean;
  limit?: number;
}
