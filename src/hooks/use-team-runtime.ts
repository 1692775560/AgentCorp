import { useEffect, useRef, useState } from 'react';
import { hostApiFetch } from '@/lib/host-api';

export type RuntimeSessionSummary = {
  id: string;
  parentSessionKey: string;
  sessionKey: string;
  status: 'running' | 'blocked' | 'waiting_approval' | 'error' | 'completed' | 'killed';
  prompt: string;
  agentName?: string;
  createdAt: string;
  updatedAt: string;
  history: Array<{
    role: string;
    content: unknown;
    timestamp?: number;
    toolName?: string;
    isError?: boolean;
  }>;
};

export type TeamRuntimeState = {
  byAgent: Record<string, RuntimeSessionSummary[]>;
  allSessions: RuntimeSessionSummary[];
  loading: boolean;
};

function extractAgentId(parentSessionKey: string): string | null {
  const match = parentSessionKey.match(/^agent:([^:]+):/);
  return match ? match[1] : null;
}

/**
 * 会话列表签名：轮询去重用。每 3s 拉一次 /api/sessions/subagents（含完整 history），
 * 若内容无变化就跳过 setState，避免 TeamMap 每轮整页重渲染。
 * 取 id/status/updatedAt/history 长度/末条消息时间戳，足以覆盖追加与状态翻转。
 */
export function runtimeSessionsSignature(sessions: RuntimeSessionSummary[]): string {
  return sessions
    .map((s) => {
      const last = s.history[s.history.length - 1];
      return `${s.id}:${s.status}:${s.updatedAt}:${s.history.length}:${last?.timestamp ?? ''}`;
    })
    .join('|');
}

/**
 * 轮询间隔：连续失败时指数退避（3s → 6s → 12s … 封顶 30s），成功后归位。
 * 此前 catch 后下一轮仍按 3s 猛打——host 挂掉时渲染进程会无意义地高频重试。
 */
export const TEAM_RUNTIME_POLL_BASE_MS = 3000;
export const TEAM_RUNTIME_POLL_MAX_MS = 30000;

export function teamRuntimePollDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return TEAM_RUNTIME_POLL_BASE_MS;
  return Math.min(
    TEAM_RUNTIME_POLL_BASE_MS * 2 ** (consecutiveFailures - 1),
    TEAM_RUNTIME_POLL_MAX_MS,
  );
}

export function useTeamRuntime(enabled = true): TeamRuntimeState {
  const [state, setState] = useState<TeamRuntimeState>({
    byAgent: {},
    allSessions: [],
    loading: true,
  });
  /** 上一轮已下发到 state 的会话签名；相同则跳过 setState。 */
  const lastSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;

    const tick = async () => {
      if (stopped || inFlight) return;
      // 页面隐藏时暂停轮询（后台无观众，省网络与解析；回前台立即补一轮）
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(() => void tick(), TEAM_RUNTIME_POLL_BASE_MS);
        return;
      }
      inFlight = true;
      try {
        const result = await hostApiFetch<{ success: boolean; sessions: RuntimeSessionSummary[] }>(
          '/api/sessions/subagents',
        );
        consecutiveFailures = 0;
        if (result.success) {
          const activeSessions = result.sessions
            .filter(
              (s) => s.status === 'running' || s.status === 'blocked' || s.status === 'waiting_approval',
            )
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()); // newest first

          const byAgent: Record<string, RuntimeSessionSummary[]> = {};
          for (const session of activeSessions) {
            const agentId = extractAgentId(session.parentSessionKey);
            if (!agentId) continue;
            if (!byAgent[agentId]) byAgent[agentId] = [];
            byAgent[agentId].push(session);
          }

          const signature = runtimeSessionsSignature(activeSessions);
          if (signature === lastSignatureRef.current) {
            // 内容无变化：只补 loading 终结，不换新引用，订阅组件不渲染
            setState((prev) => (prev.loading ? { ...prev, loading: false } : prev));
          } else {
            lastSignatureRef.current = signature;
            setState({ byAgent, allSessions: activeSessions, loading: false });
          }
        }
      } catch {
        // 失败指数退避（3s → 6s → 12s … 封顶 30s）：host 挂掉时不再固定高频猛打
        consecutiveFailures += 1;
        setState((prev) => ({ ...prev, loading: false }));
      } finally {
        inFlight = false;
        if (!stopped) {
          timer = setTimeout(() => void tick(), teamRuntimePollDelayMs(consecutiveFailures));
        }
      }
    };

    void tick();

    const onVisibilityChange = () => {
      if (stopped || document.hidden) return;
      if (timer) clearTimeout(timer);
      void tick();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled]);

  return state;
}
