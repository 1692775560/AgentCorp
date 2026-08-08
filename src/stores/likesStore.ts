/**
 * src/stores/likesStore.ts
 * 小红心点赞内存镜像 + 乐观更新（T05 / 设计 §5）。
 *
 * - 内存镜像：likes[agentId] = LikeRecord（渲染层即时反馈）
 * - 乐观更新：toggle 立即翻转个人态与计数，落库失败回滚
 * - 数据真相：src/services/reactionStore.ts（electron-store `agentcorp.reactions`）
 *
 * 与 marketplace store 的关系：MarketCandidateCard 直接订阅本 store，
 * 无需把 likeCount 塞进 MarketCandidateView（保持视图层契约最小化）。
 */
import { create } from 'zustand';
import { getLike as readLike, toggleLike as persistToggle } from '@/services/reactionStore';
import type { LikeRecord } from '@/types/reactions';

interface LikesState {
  /** agentId → LikeRecord（内存镜像，未加载过则缺省） */
  likes: Record<string, LikeRecord>;
  /** 正在 toggle 的 agentId 集合（防连点） */
  toggling: Record<string, boolean>;
  error: string | null;

  /** 加载某 agent 点赞状态（幂等） */
  hydrate: (agentId: string) => Promise<LikeRecord>;
  /** 乐观 toggle：立即翻转 + 计数 ±1，落库失败回滚 */
  toggle: (agentId: string) => Promise<LikeRecord>;
  clearError: () => void;
}

function defaultRecord(agentId: string): LikeRecord {
  return { agentId, count: 0, likedByMe: false, users: [], updatedAt: new Date().toISOString() };
}

export const useLikesStore = create<LikesState>((set, get) => ({
  likes: {},
  toggling: {},
  error: null,

  hydrate: async (agentId) => {
    if (!agentId) return defaultRecord(agentId);
    const cached = get().likes[agentId];
    if (cached) return cached;
    try {
      const record = await readLike(agentId);
      set((s) => ({ likes: { ...s.likes, [agentId]: record } }));
      return record;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '点赞状态加载失败' });
      return defaultRecord(agentId);
    }
  },

  toggle: async (agentId) => {
    if (!agentId) throw new Error('agentId 不能为空');
    if (get().toggling[agentId]) return get().likes[agentId] ?? defaultRecord(agentId);

    const prev = get().likes[agentId] ?? defaultRecord(agentId);
    const optimistic: LikeRecord = {
      ...prev,
      count: prev.likedByMe ? Math.max(0, prev.count - 1) : prev.count + 1,
      likedByMe: !prev.likedByMe,
      updatedAt: new Date().toISOString(),
    };
    set((s) => ({
      likes: { ...s.likes, [agentId]: optimistic },
      toggling: { ...s.toggling, [agentId]: true },
      error: null,
    }));
    try {
      const persisted = await persistToggle(agentId);
      set((s) => ({
        likes: { ...s.likes, [agentId]: persisted },
        toggling: { ...s.toggling, [agentId]: false },
      }));
      return persisted;
    } catch (e) {
      // 回滚到 toggle 前状态
      set((s) => ({
        likes: { ...s.likes, [agentId]: prev },
        toggling: { ...s.toggling, [agentId]: false },
        error: `点赞失败，已回滚：${e instanceof Error ? e.message : String(e)}`,
      }));
      return prev;
    }
  },

  clearError: () => set({ error: null }),
}));

export const likesStore = useLikesStore;
