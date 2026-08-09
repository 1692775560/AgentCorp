/**
 * src/stores/officeWork.ts
 * Agent Office · 派活工作台 store（真实调度，单一真相源）。
 *
 * 职责：在 Office 里对「在岗 agent」真实派发任务 —— 复用已验证的调度通道
 * services/interviewRunner.askAgent（gateway.rpc('chat.send') → 轮询 chat.history），
 * 并把每个 agent 的工作状态 / 任务 / 产出 / runId / 时延回填，供员工卡渲染。
 *
 * 设计约束：
 * - 不重造调度链路，直接复用 askAgent（真实优先、失败降级不阻塞）。
 * - 每个 agent 一条工作记录；重复派活覆盖同一条（保留历史产出到 lastReply）。
 * - 纯前端内存状态；刷新后清空（工作产出的持久化真相在网关会话历史里）。
 */
import { create } from 'zustand';

import { askAgent } from '@/services/interviewRunner';

/** 单个 agent 的工作状态机。 */
export type WorkStatus = 'idle' | 'working' | 'done' | 'failed';

/** 一个 agent 的工作记录（回填到员工卡）。 */
export interface WorkRecord {
  agentId: string;
  status: WorkStatus;
  /** 最近派发的任务描述 */
  task: string;
  /** agent 产出原文（done 时填充） */
  reply: string;
  /** 真实调度主键（chat.send 返回） */
  runId: string | null;
  /** 执行时延（ms） */
  latencyMs: number | null;
  /** 实际生效通道：agent=真实调度 / manual=降级（网关不可用） */
  mode: 'agent' | 'manual' | null;
  /** 失败或降级原因 */
  error?: string;
  /** 最近一次更新时间（ms） */
  updatedAt: number;
}

interface OfficeWorkState {
  /** agentId → 工作记录 */
  records: Record<string, WorkRecord>;
  /**
   * 对某在岗 agent 真实派发一个任务。
   * @param agentId    目标 agent
   * @param sessionKey 会话键（来自 OfficeEmployee.sessionKey）；缺失则直接失败提示
   * @param task       任务描述
   */
  dispatch: (agentId: string, sessionKey: string | null, task: string) => Promise<void>;
  /** 清空某 agent 的工作记录（回到 idle，可再次派活） */
  reset: (agentId: string) => void;
}

export const useOfficeWorkStore = create<OfficeWorkState>((set, get) => ({
  records: {},

  dispatch: async (agentId, sessionKey, task) => {
    const trimmed = task.trim();
    if (trimmed.length === 0) return;

    // 无会话键 → 无法真实调度，直接落 failed（明确告知，不静默）
    if (!sessionKey) {
      set((s) => ({
        records: {
          ...s.records,
          [agentId]: {
            agentId,
            status: 'failed',
            task: trimmed,
            reply: '',
            runId: null,
            latencyMs: null,
            mode: null,
            error: '该 agent 缺少会话键（mainSessionKey），无法真实派发任务',
            updatedAt: Date.now(),
          },
        },
      }));
      return;
    }

    // 置为 working
    set((s) => ({
      records: {
        ...s.records,
        [agentId]: {
          agentId,
          status: 'working',
          task: trimmed,
          reply: '',
          runId: null,
          latencyMs: null,
          mode: null,
          updatedAt: Date.now(),
        },
      },
    }));

    // 真实调度：复用 interviewRunner.askAgent（chat.send → 轮询 history）
    const result = await askAgent({ sessionKey, question: trimmed });

    // 若期间被 reset 覆盖（记录不再是 working 的同一任务），仍安全写回最新结果
    const prev = get().records[agentId];
    const succeeded = result.mode === 'agent' && result.replyText.trim().length > 0;

    set((s) => ({
      records: {
        ...s.records,
        [agentId]: {
          agentId,
          status: succeeded ? 'done' : 'failed',
          task: prev?.task ?? trimmed,
          reply: result.replyText,
          runId: result.runId,
          latencyMs: result.latencyMs,
          mode: result.mode,
          error: succeeded
            ? undefined
            : result.error ??
              (result.mode === 'manual'
                ? '网关未连接，已降级（无法自动执行）'
                : 'agent 未在超时内返回产出'),
          updatedAt: Date.now(),
        },
      },
    }));
  },

  reset: (agentId) => {
    set((s) => {
      const next = { ...s.records };
      delete next[agentId];
      return { records: next };
    });
  },
}));
