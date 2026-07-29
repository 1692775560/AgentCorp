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
