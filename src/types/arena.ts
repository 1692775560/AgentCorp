/**
 * src/types/arena.ts
 * Arena 个性化对决契约层（模块 Arena · 设计 §2 / docs/api/contracts.md §1.3）。
 *
 * 字段以 contracts.md 为准（camelCase）。与 model-service/app/schemas.py
 * 的 ArenaMatch / ArenaCandidateAnswer / ArenaPickResult 严格镜像。
 */
import type { JobType } from '@/types/evaluation';

/** 对决上下文：独立页 / 面试用户自定义题 */
export type ArenaContext = 'arena' | 'interview';

/** 用户主观选择：agent_id | 'draw' | 'none' */
export type ArenaPick = string | 'draw' | 'none';

/** 对决状态机 */
export type ArenaStatus = 'pending' | 'picked' | 'abandoned';

/** 候选引用（同后端 ArenaCandidateRef；text 通道直接给 answer） */
export interface CandidateRef {
  agentId: string;
  agentName?: string;
  channel?: 'text' | 'gateway';
  answer?: string;
  endpoint?: string;
  model?: string;
  apiKey?: string;
}

/** arena_judge 客观评判输出（dims 为工种 craft 维子集 + fit 需求贴合维） */
export interface ArenaJudgeOutput {
  dims: Record<string, number>;
  unscoredDims: string[];
  checkpoints: { checkpoint: string; hit: boolean; quote: string }[];
  paddingDetected: boolean;
  paddingNote: string;
  confidence: number;
  fit: number;
}

/** 单个候选的对决作答 */
export interface ArenaCandidateResult {
  agentId: string;
  agentName: string;
  answerText: string;
  channel: string;
  latencyMs: number;
  judgement?: ArenaJudgeOutput | null;
  objectiveTotal: number;
}

/** 一场对决（pending → picked/abandoned） */
export interface ArenaMatch {
  matchId: string;
  context: ArenaContext;
  interviewId?: string | null;
  requirementText: string;
  taskPrompt: string;
  jobType: JobType;
  candidates: ArenaCandidateResult[];
  objectiveLeader: string | null;
  userPick: ArenaPick | null;
  status: ArenaStatus;
  eloDelta: Record<string, number>;
  createdAt: string;
  pickedAt?: string | null;
}

/** user-pick 回包：双轨 Elo 快照 */
export interface ArenaPickResult {
  matchId: string;
  status: 'picked' | 'abandoned';
  userPick: ArenaPick;
  winner?: string | 'draw' | null;
  eloDelta: Record<string, number>;
  subjectiveRatings: Record<string, number>;
  objectiveRatings: Record<string, number>;
}

/** Elo 快照（主观主榜 + 客观辅榜），ArenaPage 排行区展示用 */
export interface EloSnapshot {
  subjectiveRatings: Record<string, number>;
  objectiveRatings: Record<string, number>;
}

/** compare 入参（judgeClient.arenaCompare） */
export interface ArenaCompareInput {
  requirementText: string;
  jobType: JobType;
  candidates: CandidateRef[];
  context?: ArenaContext;
  interviewId?: string | null;
}

/** user-pick 入参（judgeClient.arenaUserPick） */
export interface ArenaUserPickInput {
  matchId: string;
  pick: ArenaPick;
}
