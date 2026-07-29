/**
 * src/stores/convergenceStore.ts
 * Layer3 收敛层 Zustand store（T17）。
 *
 * 职责（编排 T13–T16 前端侧闭环）：
 *   - 持有当前收敛轨迹 trace / 评分 score / 锚点库 anchors（内存镜像）；
 *   - 编排收敛服务 convergenceService（网络 + electron-store 缓存）；
 *   - 暴露 recordTurn / setAnchor / computeScore 三个核心动作；
 *   - explicit_pin：MVP 的「临时锚点源」——用户置顶某候选后，
 *     先以 explicitPin 暂存（不落库、不覆盖轨迹），commit 时才写入。
 *     （批次 2 后回填 dual_leaderboard_drag 来源，本 store 已预留 ConvSource。）
 *
 * 数据真相在 electron-store（agentcorp.convergence），本 store 仅持内存镜像。
 * 任一网络/缓存环节失败不中断其余流程（与 evaluation.ts 同口径）。
 */
import { create } from 'zustand';
import type {
  ConvergenceTrace,
  ConvergenceScore,
  HumanAnchor,
  TurnState,
  CandidateEmbedding,
  ConvSource,
} from '@/types/convergence';
import {
  convergenceService,
} from '@/services/convergenceService';
import {
  computeConvergenceScore,
  DEFAULT_CONVERGENCE_CONFIG,
  type ConvergenceConfigLike,
} from '@/engine/convergence/score';

interface ConvergenceState {
  /** 当前轨迹（一次评估运行） */
  trace: ConvergenceTrace | null;
  /** 最近一次收敛评分 */
  score: ConvergenceScore | null;
  /** 锚点库（进程内镜像） */
  anchors: HumanAnchor[];
  /** MVP 临时锚点源：用户置顶的候选（explicit_pin），commit 前不落库 */
  explicitPin: HumanAnchor | null;
  /** 可配权重/scale（与后端 ConvergenceConfig 默认一致） */
  config: ConvergenceConfigLike;

  /** 初始化一条空轨迹 */
  initTrace: (args: {
    runId: string;
    agentId: string;
    jobType?: string;
    k?: number;
    createdBy: string;
  }) => void;

  /** 记录/合并一轮状态（按 turn 号：同号替换，否则追加） */
  recordTurn: (turnState: TurnState) => void;

  /** 置顶某候选为临时锚点（explicit_pin 源，不立即落库） */
  pinCandidate: (
    _turn: number,
    candidate: CandidateEmbedding,
    source?: ConvSource,
  ) => void;

  /** 提交临时锚点：落库（POST /api/convergence/anchor）+ 设 human_anchor_id */
  commitPin: () => Promise<void>;

  /** 计算收敛评分（本地镜像公式 + 服务端权威对拍；失败保本地） */
  computeScore: () => Promise<ConvergenceScore | null>;

  /** 从服务端拉取评分 + 锚点（按 ownerId） */
  loadFromServer: (runId: string, ownerId?: string) => Promise<void>;

  /** 清空当前会话（保留 electron-store 落库数据） */
  reset: () => void;
}

function makeAnchorId(runId: string, candidateId: string): string {
  return `anchor-${runId}-${candidateId}`;
}

export const useConvergenceStore = create<ConvergenceState>((set, get) => ({
  trace: null,
  score: null,
  anchors: [],
  explicitPin: null,
  config: DEFAULT_CONVERGENCE_CONFIG,

  initTrace: ({ runId, agentId, jobType = 'code', k = 3, createdBy }) => {
    const trace: ConvergenceTrace = {
      run_id: runId,
      agent_id: agentId,
      job_type: jobType as ConvergenceTrace['job_type'],
      k,
      turns: [],
      created_by: createdBy,
      ts: new Date().toISOString(),
    };
    set({ trace, score: null, explicitPin: null });
    void convergenceService.cacheTrace(trace);
    // 预热锚点库
    void convergenceService
      .getAnchors(createdBy)
      .then((anchors) => set({ anchors }))
      .catch(() => undefined);
  },

  recordTurn: (turnState) => {
    const trace = get().trace;
    if (!trace) return;
    const kept = trace.turns.filter((t) => t.turn !== turnState.turn);
    kept.push(turnState);
    const next: ConvergenceTrace = { ...trace, turns: kept };
    set({ trace: next });
    void convergenceService.cacheTrace(next);
  },

  pinCandidate: (_turn, candidate, source = 'explicit_pin') => {
    const trace = get().trace;
    if (!trace) return;
    const anchor: HumanAnchor = {
      anchor_id: makeAnchorId(trace.run_id, candidate.candidate_id),
      candidate_id: candidate.candidate_id,
      embedding: candidate.embedding,
      owner_id: trace.created_by,
      source,
      ts: new Date().toISOString(),
    };
    set({ explicitPin: anchor });
  },

  commitPin: async () => {
    const { explicitPin, trace } = get();
    if (!explicitPin || !trace) return;
    // 落库
    try {
      await convergenceService.postAnchor(explicitPin);
    } catch {
      // 网络失败仍保留内存态，不中断
    }
    // 更新锚点库镜像 + 写回轨迹 human_anchor_id
    const anchors = [
      ...get().anchors.filter((a) => a.anchor_id !== explicitPin.anchor_id),
      explicitPin,
    ];
    const next: ConvergenceTrace = {
      ...trace,
      human_anchor_id: explicitPin.candidate_id,
    };
    set({ anchors, trace: next, explicitPin: null });
    void convergenceService.cacheTrace(next);
  },

  computeScore: async () => {
    const { trace, config } = get();
    if (!trace || trace.turns.length === 0) return null;
    // 本地镜像公式（即时反馈）
    const local = computeConvergenceScore(trace, config);
    set({ score: local });
    // 服务端权威对拍（失败保本地）
    try {
      const server = await convergenceService.postScore({ run_id: trace.run_id });
      set({ score: server });
      return server;
    } catch {
      return local;
    }
  },

  loadFromServer: async (runId, ownerId) => {
    try {
      const server = await convergenceService.postScore({ run_id: runId });
      set({ score: server });
    } catch {
      // 服务端不可用时用本地缓存/本地公式兜底
      const cached = await convergenceService.readCachedTrace(runId);
      if (cached && cached.turns.length > 0) {
        set({ trace: cached, score: computeConvergenceScore(cached, get().config) });
      }
    }
    if (ownerId) {
      try {
        const anchors = await convergenceService.getAnchors(ownerId);
        set({ anchors });
      } catch {
        // 忽略
      }
    }
  },

  reset: () => set({ trace: null, score: null, explicitPin: null }),
}));

export const convergenceStore = useConvergenceStore;
