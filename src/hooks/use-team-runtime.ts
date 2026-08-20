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

export function useTeamRuntime(enabled = true): TeamRuntimeState {
  const [state, setState] = useState<TeamRuntimeState>({
    byAgent: {},
    allSessions: [],
    loading: true,
  });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 上一轮已下发到 state 的会话签名；相同则跳过 setState。 */
  const lastSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const fetchSessions = async () => {
      try {
        const result = await hostApiFetch<{ success: boolean; sessions: RuntimeSessionSummary[] }>(
          '/api/sessions/subagents',
        );
        if (!result.success) return;

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
          return;
        }
        lastSignatureRef.current = signature;
        setState({ byAgent, allSessions: activeSessions, loading: false });
      } catch {
        setState((prev) => ({ ...prev, loading: false }));
      }
    };

    void fetchSessions();
    timerRef.current = setInterval(() => void fetchSessions(), 3000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [enabled]);

  return state;
}
