/**
 * src/types/reactions.ts
 * 小红心点赞 + BossFavorite 深度认可契约层（模块 Arena · /§5 / contracts.md §1.4/§1.5）。
 *
 * 字段以 contracts.md 为准；users/voters/votedBy/ownerId 为后端聚合预留字段，
 * 当前本地实现恒空 / 'default'。
 */
import type { JobType } from '@/types/evaluation';

/** 点赞记录（本地 count + 个人态；users 为后端聚合预留） */
export interface LikeRecord {
  agentId: string;
  count: number;
  likedByMe: boolean;
  /** [预留] 后端聚合 user_ids；本地恒空 */
  users?: string[];
  updatedAt: string;
}

/** BossFavorite 投票来源阶段 */
export type FavoriteStage = 'interview' | 'performance' | 'arena';

/** 一次 BossFavorite 投票（本地落库 + 幂等键 sourceId） */
export interface BossFavoriteVote {
  agentId: string;
  jobType: JobType;
  /** [预留] 本地默认 'default' */
  votedBy: string;
  stage: FavoriteStage;
  /** interviewId/matchId，幂等键：同 agent + stage + sourceId 不可重复 */
  sourceId?: string;
  ts: string;
}

/** 按 (jobType, agentId) 聚合的青睐记录 */
export interface FavoriteAggregate {
  count: number;
  /** [预留] 后端聚合 user_ids 集合 */
  voters: string[];
  updatedAt: string;
}

/** 工种赛道青睐榜条目 */
export interface FavoriteRankingEntry {
  agentId: string;
  agentName?: string;
  count: number;
  voters: string[];
}

/** GET /api/favorites 回包（按 count 降序） */
export interface FavoriteRanking {
  jobType: JobType;
  ranking: FavoriteRankingEntry[];
}

/** POST /api/favorites/vote 回包 */
export interface FavoriteVoteResult {
  agentId: string;
  jobType: JobType;
  count: number;
  voted: boolean;
}

/** POST /api/favorites/vote 入参 */
export interface FavoriteVoteInput {
  agentId: string;
  jobType: JobType;
  stage: FavoriteStage;
  sourceId?: string;
  votedBy?: string;
}

/** 点赞 toggle 回包（即最新 LikeRecord） */
export type LikeToggleResult = LikeRecord;
