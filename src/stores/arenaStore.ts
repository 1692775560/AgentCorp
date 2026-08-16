/**
 * src/stores/arenaStore.ts
 * Arena 个性化对决编排 store（模块 Arena ·  / contracts.md §1.3）。
 *
 * 职责：
 * - 需求输入 → compare 请求（judgeClient.arenaCompare，经 Host API → model-service）
 * - 结果列表（双轨：LLM 客观分 + 用户主观选择）
 * - userPick 回传 → 双轨 Elo 更新 → Elo 快照展示
 * - 幂等去重（同需求+同候选集 pending 返回已有 matchId）
 *
 * 数据真相：ArenaMatch 由后端进程内缓存 + 前端内存镜像；本 store 不落库
 * （与设计 D4 一致：Arena 客观分不回写 StageScore/EvaluationProfile）。
 */
import { create } from 'zustand';
import { arenaCompare, arenaUserPick } from '@/services/judgeClient';
import type { JobType } from '@/types/evaluation';
import type {
  ArenaMatch,
  ArenaPick,
  CandidateRef,
  EloSnapshot,
} from '@/types/arena';

export type ArenaCompareStatus = 'idle' | 'comparing' | 'ready' | 'picked' | 'error';

/** compare 可选上下文（面试用户自定义题传入 context='interview' + interviewId） */
export interface ArenaCompareOptions {
  context?: 'arena' | 'interview';
  interviewId?: string | null;
}

interface ArenaState {
  /** 用户需求原文 */
  requirementText: string;
  /** 工种（code/text/image） */
  jobType: JobType;
  /** 已选候选（text 通道给 answer） */
  candidates: CandidateRef[];
  /** 最近一场对决结果（pending → picked 后保留） */
  match: ArenaMatch | null;
  /** 历史对决（供 Elo 排行区/对比视图参考） */
  history: ArenaMatch[];
  /** 双轨 Elo 快照（主观主榜 + 客观辅榜） */
  eloSnapshot: EloSnapshot;
  status: ArenaCompareStatus;
  error: string | null;

  setRequirementText: (text: string) => void;
  setJobType: (jobType: JobType) => void;
  addCandidate: (candidate: CandidateRef) => void;
  removeCandidate: (agentId: string) => void;
  setCandidates: (candidates: CandidateRef[]) => void;
  clearCandidates: () => void;
  /** 发起对决：compare → match；失败置 error（可指定 context，面试用户题用） */
  compare: (opts?: ArenaCompareOptions) => Promise<void>;
  /** 用户主观选择：pick → userPick 回传 → 双轨 Elo 快照更新 */
  pick: (pick: ArenaPick) => Promise<void>;
  reset: () => void;
  clearError: () => void;
}

const EMPTY_ELO: EloSnapshot = { subjectiveRatings: {}, objectiveRatings: {} };

export const useArenaStore = create<ArenaState>((set, get) => ({
  requirementText: '',
  jobType: 'code',
  candidates: [],
  match: null,
  history: [],
  eloSnapshot: { ...EMPTY_ELO },
  status: 'idle',
  error: null,

  setRequirementText: (text) => set({ requirementText: text }),

  setJobType: (jobType) => set({ jobType }),

  addCandidate: (candidate) => {
    const { candidates } = get();
    if (candidates.some((c) => c.agentId === candidate.agentId)) return;
    set({ candidates: [...candidates, candidate] });
  },

  removeCandidate: (agentId) =>
    set({ candidates: get().candidates.filter((c) => c.agentId !== agentId) }),

  setCandidates: (candidates) => set({ candidates }),

  clearCandidates: () => set({ candidates: [] }),

  compare: async (opts) => {
    const { requirementText, jobType, candidates } = get();
    const requirement = requirementText.trim();
    if (!requirement) {
      set({ status: 'error', error: '请先输入需求文本' });
      return;
    }
    if (candidates.length < 2) {
      set({ status: 'error', error: '至少选择两个候选 agent 才能对决' });
      return;
    }
    set({ status: 'comparing', error: null });
    try {
      const match = await arenaCompare({
        requirementText: requirement,
        jobType,
        candidates,
        context: opts?.context ?? 'arena',
        interviewId: opts?.interviewId ?? null,
      });
      if (!match) {
        set({ status: 'error', error: '对决服务不可用（后端未启动或网络错误），请稍后重试' });
        return;
      }
      set((s) => ({
        match,
        history: [match, ...s.history].slice(0, 20),
        status: 'ready',
        error: null,
      }));
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : '对决请求失败' });
    }
  },

  pick: async (pick) => {
    const { match } = get();
    if (!match) {
      set({ status: 'error', error: '尚无对决结果' });
      return;
    }
    if (match.status !== 'pending') {
      set({ status: 'error', error: '该对决已做出选择，不能重复 pick' });
      return;
    }
    try {
      const result = await arenaUserPick({ matchId: match.matchId, pick });
      if (!result) {
        set({ status: 'error', error: 'pick 回传失败（后端不可用），请稍后重试' });
        return;
      }
      const pickedMatch: ArenaMatch = {
        ...match,
        userPick: result.userPick,
        status: result.status,
        eloDelta: result.eloDelta,
        pickedAt: new Date().toISOString(),
      };
      set((s) => ({
        match: pickedMatch,
        history: s.history.map((m) => (m.matchId === pickedMatch.matchId ? pickedMatch : m)),
        eloSnapshot: {
          subjectiveRatings: result.subjectiveRatings,
          objectiveRatings: result.objectiveRatings,
        },
        status: 'picked',
        error: null,
      }));
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : 'pick 回传失败' });
    }
  },

  reset: () =>
    set({
      requirementText: '',
      jobType: 'code',
      candidates: [],
      match: null,
      history: [],
      eloSnapshot: { ...EMPTY_ELO },
      status: 'idle',
      error: null,
    }),

  clearError: () => set({ error: null }),
}));

export const arenaStore = useArenaStore;
