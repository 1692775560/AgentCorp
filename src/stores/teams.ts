import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import type { TeamSummary, CreateTeamRequest, UpdateTeamRequest, TeamsSnapshot, TeamChatEvent } from '@/types/team';

interface TeamsState {
  teams: TeamSummary[];
  loading: boolean;
  error: string | null;

  // CRUD operations
  fetchTeams: () => Promise<void>;
  createTeam: (request: CreateTeamRequest) => Promise<void>;
  updateTeam: (teamId: string, updates: UpdateTeamRequest) => Promise<void>;
  deleteTeam: (teamId: string) => Promise<void>;

  /** 团队房间追加一条消息（基于最新状态，封顶 200 条）。 */
  appendTeamChatEvent: (teamId: string, event: Omit<TeamChatEvent, 'createdAt'>) => Promise<void>;

  // Convenience methods
  addMember: (teamId: string, agentId: string) => Promise<void>;
  removeMember: (teamId: string, agentId: string) => Promise<void>;

  clearError: () => void;
}

function applySnapshot(snapshot: TeamsSnapshot | undefined) {
  return snapshot ? { teams: snapshot.teams } : {};
}

export const useTeamsStore = create<TeamsState>((set, get) => ({
  teams: [],
  loading: false,
  error: null,

  fetchTeams: async () => {
    set({ loading: true, error: null });
    try {
      const snapshot = await hostApiFetch<TeamsSnapshot>('/api/teams');
      set({
        ...applySnapshot(snapshot),
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  createTeam: async (request: CreateTeamRequest) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<TeamsSnapshot>('/api/teams', {
        method: 'POST',
        body: JSON.stringify(request),
      });
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateTeam: async (teamId: string, updates: UpdateTeamRequest) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<TeamsSnapshot>(
        `/api/teams/${encodeURIComponent(teamId)}`,
        {
          method: 'PUT',
          body: JSON.stringify(updates),
        }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  deleteTeam: async (teamId: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<TeamsSnapshot>(
        `/api/teams/${encodeURIComponent(teamId)}`,
        { method: 'DELETE' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  addMember: async (teamId: string, agentId: string) => {
    const team = get().teams.find((t) => t.id === teamId);
    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }

    // Add member if not already present
    const memberIds = team.memberIds.includes(agentId)
      ? team.memberIds
      : [...team.memberIds, agentId];

    await get().updateTeam(teamId, { memberIds });
  },

  removeMember: async (teamId: string, agentId: string) => {
    const team = get().teams.find((t) => t.id === teamId);
    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }

    // Remove member from list
    const memberIds = team.memberIds.filter((id) => id !== agentId);

    await get().updateTeam(teamId, { memberIds });
  },

  clearError: () => set({ error: null }),

  appendTeamChatEvent: async (teamId, event) => {
    // 本地无此团队 → 静默无操作（与读-改-写时代行为一致，也省一次必然失败的请求）
    const team = get().teams.find((t) => t.id === teamId);
    if (!team) return;
    set({ error: null });
    try {
      // 服务端原子 append 端点（不再读-改-写 PUT 整个 team，避免并发追加互相覆盖丢消息）；
      // createdAt 与 200 条封顶由服务端处理，返回最新 teams 快照直接套用。
      const snapshot = await hostApiFetch<TeamsSnapshot>(
        `/api/teams/${encodeURIComponent(teamId)}/chat-events`,
        {
          method: 'POST',
          body: JSON.stringify(event),
        }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
}));
