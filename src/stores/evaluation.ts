/**
 * src/stores/evaluation.ts
 * 评估中心 Zustand store（AgentCorp 评估层编排中枢，T04）。
 *
 * 职责：
 * - 持有全部 agent 的 EvaluationProfile 与聚合视图（radar/kpi/roi/lifecycle/leaderboard）。
 * - 编排评估服务（采集/落库均在主进程，渲染层经 Host API 访问）：
 *   - evaluationData（T05 重构）：collectRunData / listAgentSessions（主进程采集客户端）
 *   - tokenUsageCollector.buildRoiSnapshot：纯函数 ROI 计算（真实 token 成本）
 *   - judgeClient（T07）：evaluate（MiniCPM-o 外部裁判，SSE 流）
 *   - evaluationRuntime（T06）：linkRunToTask（runId ↔ task 落库）
 *   - metricsEngine：纯函数聚合 KPI
 *   - evaluationStore：Host API 客户端（主进程 electron-store 落库）
 *
 * 设计约束：
 * - 所有服务均为异步、可容错；任一环节失败不应中断其余流程（judge 失败时回退 Mock）。
 * - 数据真相在主进程 electron-store（agentcorp.evaluation），本 store 仅持内存镜像。
 */
import { create } from 'zustand';

import type {
  EvaluationProfile,
  RadarScore,
  KpiRecord,
  RoiSnapshot,
  LifecycleState,
  LeaderboardEntry,
  LeaderboardTier,
  Verdict,
} from '@/types/evaluation';
import { verdictToLifecycleState, LIFECYCLE_TO_STATE } from '@/types/lifecycle';
import { save as evalSave, list as evalList } from '@/services/evaluationStore';
import { computeKpi } from '@/engine/metricsEngine';
import { tokenUsageCollector } from '@/services/tokenUsageCollector';
import { collectRunData } from '@/services/evaluationData';
import { judgeClient, type JudgeRunInput } from '@/services/judgeClient';
import { linkRunToTask } from '@/services/evaluationRuntime';
import { speech } from '@/services/speech';

/** 一次评估运行的入参（由 Evaluation 页面在捕获 runId 后传入） */
export interface EvaluationRunInput {
  /** 来自 gateway.rpc('chat.send') 的执行主键；缺失时仅做本地画像（不写 runlink） */
  runId?: string | null;
  agentId: string;
  agentName: string;
  sessionKey: string;
  sessionId: string;
  taskId?: string;
  task?: { title: string; description: string; weight: number };
  persona?: string;
}

const ZERO_RADAR: RadarScore = {
  task: 0,
  quality: 0,
  comm: 0,
  creativity: 0,
  reliability: 0,
  cost: 0,
};

/** 当前考核窗口（ISO 周，如 2025-W30） */
function currentWindow(): string {
  const d = new Date();
  const oneJan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(
    ((d.getTime() - oneJan.getTime()) / 86_400_000 + oneJan.getDay() + 1) / 7,
  );
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

interface EvaluationState {
  profiles: Record<string, EvaluationProfile>;
  radarLatest: RadarScore | null;
  kpiLatest: KpiRecord | null;
  roiLatest: RoiSnapshot | null;
  lifecycle: Record<string, LifecycleState>;
  leaderboard: LeaderboardEntry[];
  selectedAgentId: string | null;
  streaming: boolean;
  currentRunId: string | null;
  error: string | null;
  /** 讲解文本（narration 事件增量累计，重新评估时清空） */
  narrationText: string;
  /** 语音播报开关（默认开） */
  voiceEnabled: boolean;

  /** 从 electron-store 载入全部评估档案 */
  loadAll: () => Promise<void>;
  /** 保存（覆盖写）某个 agent 的评估档案 */
  upsertProfile: (profile: EvaluationProfile) => Promise<void>;
  /** 局部刷新某 agent 的画像字段 */
  setRunResult: (agentId: string, patch: Partial<EvaluationProfile>) => Promise<void>;
  /** 治理动作：软退休 / 回岗（仅改 lifecycle 并落库，不物理删除） */
  setLifecycle: (agentId: string, state: LifecycleState) => Promise<void>;
  /** 依据当前 profiles 重算擂台排名 */
  runLeaderboard: () => void;
  /** 完整评估编排：真实 KPI/ROI + 外部裁判 → 画像落库 + runlink */
  runEvaluation: (input: EvaluationRunInput) => Promise<EvaluationProfile | null>;
  selectAgent: (agentId: string | null) => void;
  clearError: () => void;
  toggleVoice: () => void;
}

/**
 * 由 profiles 重算擂台排名。
 * - 按 roi（缺省 roi_norm 时）降序；
 * - 榜首标记 MVP；已退休标记 BOTTOM；末位（非退休）亦标记 BOTTOM 以呈现「末位淘汰」候选。
 */
function computeLeaderboard(
  profiles: Record<string, EvaluationProfile>,
  names: Record<string, string>,
): LeaderboardEntry[] {
  const all = Object.values(profiles);
  if (all.length === 0) return [];

  const withRoi = all
    .map((p) => ({
      profile: p,
      roi: p.roiLatest?.roi ?? 0,
      roiNorm: p.roiLatest?.roi_norm ?? 0,
    }))
    .sort((a, b) => b.roi - a.roi);

  const total = withRoi.length;
  return withRoi.map((item, idx) => {
    const rank = idx + 1;
    const state = item.profile.lifecycle;
    let tier: LeaderboardTier = 'NORMAL';
    if (state === 'RETIRED') tier = 'BOTTOM';
    else if (rank === 1) tier = 'MVP';
    else if (rank === total) tier = 'BOTTOM'; // 末位淘汰候选
    return {
      agentId: item.profile.agentId,
      name: names[item.profile.agentId] ?? item.profile.agentId,
      rank,
      user_fit: Math.round((item.profile.radarLatest?.task ?? 0) * 20),
      roi_norm: item.roiNorm,
      state,
      tier,
    } satisfies LeaderboardEntry;
  });
}

export const useEvaluationStore = create<EvaluationState>((set, get) => ({
  profiles: {},
  radarLatest: null,
  kpiLatest: null,
  roiLatest: null,
  lifecycle: {},
  leaderboard: [],
  selectedAgentId: null,
  streaming: false,
  currentRunId: null,
  error: null,
  narrationText: '',
  voiceEnabled: true,

  loadAll: async () => {
    try {
      const profiles = await evalList();
      const map: Record<string, EvaluationProfile> = {};
      const lifecycle: Record<string, LifecycleState> = {};
      for (const p of profiles) {
        map[p.agentId] = p;
        lifecycle[p.agentId] = p.lifecycle;
      }
      set({ profiles: map, lifecycle });
      get().runLeaderboard();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  upsertProfile: async (profile) => {
    await evalSave(profile);
    set((state) => ({
      profiles: { ...state.profiles, [profile.agentId]: profile },
      lifecycle: { ...state.lifecycle, [profile.agentId]: profile.lifecycle },
    }));
    get().runLeaderboard();
  },

  setRunResult: async (agentId, patch) => {
    const prev = get().profiles[agentId];
    if (!prev) return;
    const next: EvaluationProfile = { ...prev, ...patch, agentId, updatedAt: new Date().toISOString() };
    await evalSave(next);
    set((state) => ({
      profiles: { ...state.profiles, [agentId]: next },
      lifecycle: { ...state.lifecycle, [agentId]: next.lifecycle },
    }));
    get().runLeaderboard();
  },

  setLifecycle: async (agentId, state) => {
    const prev = get().profiles[agentId];
    if (!prev) {
      // 尚无画像时仅记录生命周期（写入最小画像）
      const minimal: EvaluationProfile = {
        agentId,
        radarLatest: { ...ZERO_RADAR },
        radarHistory: [],
        kpiLatest: emptyKpi(agentId),
        kpiHistory: [],
        roiLatest: emptyRoi(agentId),
        lifecycle: state,
        runIds: [],
        updatedAt: new Date().toISOString(),
      };
      await evalSave(minimal);
      set((s) => ({
        profiles: { ...s.profiles, [agentId]: minimal },
        lifecycle: { ...s.lifecycle, [agentId]: state },
      }));
      get().runLeaderboard();
      return;
    }
    const next: EvaluationProfile = { ...prev, lifecycle: state, updatedAt: new Date().toISOString() };
    await evalSave(next);
    set((s) => ({
      profiles: { ...s.profiles, [agentId]: next },
      lifecycle: { ...s.lifecycle, [agentId]: state },
    }));
    get().runLeaderboard();
  },

  runLeaderboard: () => {
    const { profiles } = get();
    set({ leaderboard: computeLeaderboard(profiles, {}) });
  },

  runEvaluation: async (input) => {
    speech.cancel(); // 打断上一次播报
    set({
      streaming: true,
      error: null,
      currentRunId: input.runId ?? null,
      selectedAgentId: input.agentId,
      narrationText: '',
    });
    try {
      // 1+2) 一次采集：token 用量 + 遥测事件 + 转录（主进程完成，sessionId 为空时仅按 agent 兜底）
      const { events, transcript, entries } = await collectRunData(input.agentId, input.sessionId);

      // 3) 客观 KPI（来自真实遥测）
      const window = currentWindow();
      const kpi = computeKpi(events, window, get().profiles[input.agentId]?.radarHistory ?? []);

      // 4) ROI（使用真实 token 成本 / 用量）
      const roi = tokenUsageCollector.buildRoiSnapshot(entries, events, input.agentId, window);

      // 5) 外部裁判（MiniCPM-o），失败时 judgeClient 内部回退 Mock
      const judgeInput: JudgeRunInput = {
        agentId: input.agentId,
        agentName: input.agentName,
        persona: input.persona,
        task: input.task ?? { title: 'Ad-hoc task', description: '', weight: 1 },
        transcript,
        usage: entries,
      };

      const radar: Partial<RadarScore> = {};
      let verdict: Verdict | null = null;
      let verdictUserFit = 0;
      let sawAudio = false; // 本流出现过 audio 事件 → narration 只上屏（防双播）
      for await (const ev of judgeClient.evaluate(judgeInput)) {
        if (ev.type === 'radar_update') {
          radar[ev.dim] = ev.score;
          set({ radarLatest: { ...ZERO_RADAR, ...radar } });
        } else if (ev.type === 'narration') {
          if (ev.delta) {
            set((state) => ({ narrationText: state.narrationText + ev.delta }));
            if (!sawAudio) speech.speak(ev.delta);
          }
        } else if (ev.type === 'audio') {
          sawAudio = true;
          void speech.playAudioChunk(ev.chunk, ev.format, ev.sample_rate);
        } else if (ev.type === 'verdict') {
          verdict = ev.verdict;
          verdictUserFit = ev.user_fit;
        }
      }

      // 语音宣判：流中无 audio 宣判块时（fallbackMock / tts 不可用）合成文本兜底
      if (verdict && !sawAudio) {
        const label =
          verdict === 'MVP' ? 'MVP' : verdict === 'OBSERVE' ? '待观察' : 'You are fired';
        speech.speak(`综合判定：${label}。用户契合度 ${Math.round(verdictUserFit)}%。`);
      }

      const radarScore: RadarScore = { ...ZERO_RADAR, ...radar };
      const lifecycle: LifecycleState = verdict
        ? verdictToLifecycleState(verdict)
        : LIFECYCLE_TO_STATE.active;

      // 6) 落库画像
      const prev = get().profiles[input.agentId];
      const profile: EvaluationProfile = {
        agentId: input.agentId,
        radarLatest: radarScore,
        radarHistory: [...(prev?.radarHistory ?? []), radarScore],
        kpiLatest: kpi,
        kpiHistory: [...(prev?.kpiHistory ?? []), kpi],
        roiLatest: roi,
        lifecycle,
        runIds: [...(prev?.runIds ?? []), ...(input.runId ? [input.runId] : [])],
        updatedAt: new Date().toISOString(),
      };
      await evalSave(profile);

      // 7) runId ↔ task 关联落库（T06 捕获点）
      if (input.runId) {
        await linkRunToTask(input.runId, {
          taskId: input.taskId ?? '',
          agentId: input.agentId,
          sessionKey: input.sessionKey,
          sessionId: input.sessionId,
        });
      }

      set((state) => ({
        profiles: { ...state.profiles, [input.agentId]: profile },
        radarLatest: radarScore,
        kpiLatest: kpi,
        roiLatest: roi,
        lifecycle: { ...state.lifecycle, [input.agentId]: lifecycle },
        streaming: false,
      }));
      get().runLeaderboard();
      return profile;
    } catch (e) {
      set({ streaming: false, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  selectAgent: (agentId) => {
    set({ selectedAgentId: agentId });
    const p = agentId ? get().profiles[agentId] : null;
    // 无画像时清空右栏镜像，避免残留上一个 agent 的雷达/KPI/ROI。
    set({
      radarLatest: p?.radarLatest ?? null,
      kpiLatest: p?.kpiLatest ?? null,
      roiLatest: p?.roiLatest ?? null,
    });
  },

  clearError: () => set({ error: null }),

  toggleVoice: () => {
    const next = !get().voiceEnabled;
    speech.setEnabled(next);
    set({ voiceEnabled: next });
  },
}));

/** KPI 零值占位（治理动作在无画像时使用） */
function emptyKpi(agentId: string): KpiRecord {
  return {
    agentId,
    task_completion_rate: 0,
    first_success_rate: 0,
    rework_rate: 0,
    avg_delivery_latency_ms: 0,
    autonomy_rate: 0,
    escalation_rate: 0,
    cross_task_generalization: 0,
    stability_consistency: 0,
    sample_n: 0,
    window: currentWindow(),
    computedAt: new Date().toISOString(),
  };
}

/** ROI 零值占位 */
function emptyRoi(agentId: string): RoiSnapshot {
  return {
    agentId,
    cost_total: 0,
    value_total: 0,
    roi: 0,
    ipr: 0,
    srpc: 0,
    cost_perf_score: 0,
    roi_index: 0,
    roi_norm: 0,
    window: currentWindow(),
  };
}
