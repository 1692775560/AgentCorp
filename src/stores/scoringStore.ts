/**
 * src/stores/scoringStore.ts
 * 评估层扩展编排中枢（批次2：T6/T7/T8/T9 前端侧）。
 *
 * 职责：
 * - onScore：本阶段启用的 sub_* 维打分（0–5，0.5 步进）→ 局部主观分 map。
 * - onReorder(agentId, srcRank, dstRank)：拖拽 → 生成 PreferenceSignal →
 *   preferenceStore.appendSignal + POST /api/preference 回灌 UserPreference.weight。
 * - capturePreference：把回灌后的 weight 落到本地（供下次 compute_user_fit 体现）。
 * - runStage：编排三阶段评分卡（调 /api/evaluate-stage）。
 * - loadDualLeaderboard：拉取双 Leaderboard（调 leaderboardClient）。
 *
 * 数据真相在 electron-store（agentcorp.scoring-rules / agentcorp.preference /
 * agentcorp.stage-scores），本 store 仅持内存镜像。任一网络/缓存环节失败不中断。
 */
import { create } from 'zustand';
import type {
  StageKey,
  JobType,
  SubjectiveDim,
  PreferenceSignal,
  PreferenceProfile,
  StageScore,
  StageScoreRequest,
  DualLeaderboard,
  CraftScores,
  RadarDim,
} from '@/types/evaluation';
import { hostApiFetch } from '@/lib/host-api';
import { preferenceStore } from '@/services/preferenceStore';
import { leaderboardClient } from '@/services/leaderboardClient';
import { stageScoreStore } from '@/services/stageScoreStore';
import {
  load as loadEvaluationProfile,
  save as saveEvaluationProfile,
} from '@/services/evaluationStore';

/** 默认 UserPreference.weight（与后端 WeightVector 同构，Σ=1）。 */
export const DEFAULT_WEIGHT: Record<RadarDim, number> = {
  task: 0.2,
  quality: 0.2,
  comm: 0.15,
  creativity: 0.15,
  reliability: 0.15,
  cost: 0.15,
};

interface ScoringState {
  /** 主观分：key = `${stage}:${agentId}` → {sub_dim: 0–5} */
  subjectiveScores: Record<string, Partial<Record<SubjectiveDim, number>>>;
  /** 最近一次装配的 StageScore（按 agentId） */
  stageScores: Record<string, StageScore>;
  /** 当前双 Leaderboard */
  dualLeaderboard: DualLeaderboard | null;
  /** 偏好信号累计（内存镜像，持久化见 preferenceStore） */
  preferenceSignals: PreferenceSignal[];
  /** 回灌后的用户权重（供下次 compute_user_fit 体现） */
  userWeight: Record<RadarDim, number>;
  /** 最近一次回灌画像 */
  preferenceProfile: PreferenceProfile | null;
  ownerId: string;
  streaming: boolean;
  error: string | null;

  /** 主观打分（T6） */
  onScore: (agentId: string, stage: StageKey, dim: SubjectiveDim, value: number) => void;
  /** 读取某 agent 在某阶段的主观分 */
  getSubjective: (agentId: string, stage: StageKey) => Partial<Record<SubjectiveDim, number>>;
  /** 拖拽重排（T8）→ 偏好信号 → 回灌 */
  onReorder: (
    agentId: string,
    srcRank: number,
    dstRank: number,
    opts?: { stage?: StageKey; jobType?: JobType; craftScores?: CraftScores },
  ) => Promise<void>;
  /** 捕获回灌权重（持久化到本地画像） */
  capturePreference: (profile: PreferenceProfile) => void;
  /** 装配三阶段评分卡（T4） */
  runStage: (req: StageScoreRequest) => Promise<StageScore | null>;
  /** 拉取双 Leaderboard（T7） */
  loadDualLeaderboard: (stage: StageKey, jobType: JobType | 'all', subjectiveOrder?: string[]) => Promise<void>;
  clearError: () => void;
}

const subKey = (stage: StageKey, agentId: string) => `${stage}:${agentId}`;

/**
 * 阶段评分卡持久化（★通道③存储端，仅加法）。
 *
 * 两件事：
 * 1) 写 `agentcorp.stage-scores`（键 `${agentId}:${stage}`，同阶段覆盖写）；
 * 2) 同步回写 `EvaluationProfile.stageScores`，让
 *    `engine/marketplace/radarSource.latestStageScore('performance')` 能读到
 *    最新绩效卡，进而在市场页产生 perfBoost 重排。
 *
 * 全程 best-effort：非 Electron 运行时或落库异常都静默跳过，不影响评分主流程。
 */
async function persistStageScore(score: StageScore): Promise<void> {
  try {
    await stageScoreStore.save(score);
  } catch {
    // 渲染层无 electron-store（如浏览器预览）时忽略
  }
  try {
    const profile = await loadEvaluationProfile(score.agentId);
    if (!profile) return;
    const kept = (profile.stageScores ?? []).filter((item) => item.stage !== score.stage);
    await saveEvaluationProfile({
      ...profile,
      jobType: profile.jobType ?? score.jobType,
      stageScores: [...kept, score],
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // 档案不存在或落库失败不阻断
  }
}

export const useScoringStore = create<ScoringState>((set, get) => ({
  subjectiveScores: {},
  stageScores: {},
  dualLeaderboard: null,
  preferenceSignals: [],
  userWeight: { ...DEFAULT_WEIGHT },
  preferenceProfile: null,
  ownerId: 'default',
  streaming: false,
  error: null,

  onScore: (agentId, stage, dim, value) => {
    const key = subKey(stage, agentId);
    set((s) => ({
      subjectiveScores: {
        ...s.subjectiveScores,
        [key]: { ...(s.subjectiveScores[key] ?? {}), [dim]: value },
      },
    }));
  },

  getSubjective: (agentId, stage) => {
    return get().subjectiveScores[subKey(stage, agentId)] ?? {};
  },

  onReorder: async (agentId, srcRank, dstRank, opts) => {
    const ownerId = get().ownerId;
    const stage = opts?.stage ?? 'interview';
    const jobType = opts?.jobType ?? 'code';
    const direction: 'up' | 'down' = dstRank < srcRank ? 'up' : 'down';

    // 取该 agent 的 craft 维得分（若有），用于后端 dimLift 映射
    let craftScores: Record<string, number> | undefined;
    if (opts?.craftScores) {
      craftScores = Object.fromEntries(
        Object.entries(opts.craftScores.dims).map(([k, v]) => [k, v ?? 0]),
      );
    }

    const signal: PreferenceSignal = {
      id: `sig-${agentId}-${Date.now()}`,
      ownerId,
      stage,
      jobType,
      agentId,
      srcRank,
      dstRank,
      direction,
      craftScores,
      ts: new Date().toISOString(),
    };

    // 1) 本地累计落库
    await preferenceStore.appendSignal(ownerId, signal);
    const allSignals = await preferenceStore.loadSignals(ownerId);
    set({ preferenceSignals: allSignals });

    // 2) 调 /api/preference 回灌（携带累计信号 + 当前权重）
    try {
      const res = await hostApiFetch<{
        ownerId: string;
        weight: Record<RadarDim, number>;
        dimLift: Partial<Record<RadarDim, number>>;
        N: number;
        applied: boolean;
        pending: boolean;
      }>('/api/preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerId,
          signals: allSignals,
          currentWeight: get().userWeight,
        }),
      });
      const newWeight = res.weight as Record<RadarDim, number>;
      set({ userWeight: newWeight });
      // 3) 捕获回灌画像持久化
      const profile: PreferenceProfile = {
        ownerId: res.ownerId,
        signals: allSignals,
        pairwiseWins: {},
        dimLift: res.dimLift,
        updatedAt: new Date().toISOString(),
      };
      await preferenceStore.saveProfile(ownerId, profile);
      set({ preferenceProfile: profile });
    } catch {
      // 网络失败：保留本地信号，下次重试
      set({ error: '偏好回灌请求失败（本地已记录信号）' });
    }
  },

  capturePreference: (profile) => {
    set({ preferenceProfile: profile });
  },

  runStage: async (req) => {
    set({ streaming: true, error: null });
    try {
      const ss = await hostApiFetch<StageScore>('/api/evaluate-stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      set((s) => ({
        stageScores: { ...s.stageScores, [req.agentId]: ss },
        streaming: false,
      }));
      // ★ 通道③（存储端）：评分卡落库 + 同步回写评估档案，
      // 让市场页的 perfBoost / 面试页的基线在刷新后仍可读到（best-effort，不阻断）。
      await persistStageScore(ss);
      return ss;
    } catch (e) {
      set({
        streaming: false,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  },

  loadDualLeaderboard: async (stage, jobType, subjectiveOrder) => {
    try {
      const lb = await leaderboardClient.getDualLeaderboard(stage, jobType, subjectiveOrder);
      set({ dualLeaderboard: lb });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  clearError: () => set({ error: null }),
}));

export const scoringStore = useScoringStore;
