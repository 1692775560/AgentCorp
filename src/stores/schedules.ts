import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import type {
  CreateScheduleRequest,
  SchedulesSnapshot,
  TeamSchedule,
  UpdateScheduleRequest,
} from '@/types/schedule';

interface SchedulesState {
  schedules: TeamSchedule[];
  loading: boolean;
  error: string | null;

  fetchSchedules: (teamId?: string) => Promise<void>;
  createSchedule: (request: CreateScheduleRequest) => Promise<void>;
  updateSchedule: (scheduleId: string, updates: UpdateScheduleRequest) => Promise<void>;
  deleteSchedule: (scheduleId: string) => Promise<void>;

  clearError: () => void;
}

function applySnapshot(snapshot: SchedulesSnapshot | undefined) {
  return snapshot ? { schedules: snapshot.schedules } : {};
}

export const useSchedulesStore = create<SchedulesState>((set) => ({
  schedules: [],
  loading: false,
  error: null,

  fetchSchedules: async (teamId) => {
    set({ loading: true, error: null });
    try {
      const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
      const snapshot = await hostApiFetch<SchedulesSnapshot>(`/api/schedules${query}`);
      set({
        ...applySnapshot(snapshot),
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  createSchedule: async (request) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<SchedulesSnapshot>('/api/schedules', {
        method: 'POST',
        body: JSON.stringify(request),
      });
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateSchedule: async (scheduleId, updates) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<SchedulesSnapshot>(
        `/api/schedules/${encodeURIComponent(scheduleId)}`,
        {
          method: 'PUT',
          body: JSON.stringify(updates),
        },
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  deleteSchedule: async (scheduleId) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<SchedulesSnapshot>(
        `/api/schedules/${encodeURIComponent(scheduleId)}`,
        { method: 'DELETE' },
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
