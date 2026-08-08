/**
 * tests/unit/likesStore.test.ts
 *
 * 小红心点赞 store 单测（T05）：
 * - hydrate 从 reactionStore 加载点赞状态
 * - toggle 乐观更新：立即翻转个人态 + 计数 ±1，落库失败回滚
 * - 防连点：toggle 进行中重复调用返回当前状态
 *
 * 隔离：mock '@/services/reactionStore'（getLike/toggleLike 内存实现）。
 * 运行：pnpm test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = new Map<string, { count: number; likedByMe: boolean }>();
let failNextToggle = false;

vi.mock('@/services/reactionStore', () => ({
  getLike: vi.fn(async (agentId: string) => {
    const rec = db.get(agentId);
    return rec
      ? { agentId, count: rec.count, likedByMe: rec.likedByMe, users: [], updatedAt: 't' }
      : { agentId, count: 0, likedByMe: false, users: [], updatedAt: 't' };
  }),
  toggleLike: vi.fn(async (agentId: string) => {
    if (failNextToggle) {
      failNextToggle = false;
      throw new Error('mock 落库失败');
    }
    const rec = db.get(agentId) ?? { count: 0, likedByMe: false };
    const next = { count: rec.likedByMe ? Math.max(0, rec.count - 1) : rec.count + 1, likedByMe: !rec.likedByMe };
    db.set(agentId, next);
    return { agentId, count: next.count, likedByMe: next.likedByMe, users: [], updatedAt: 't' };
  }),
}));

import { useLikesStore, resolveLikeKey } from '@/stores/likesStore';

describe('resolveLikeKey', () => {
  it('优先用 id，保证雇佣前后 key 不漂移', () => {
    // 雇佣前只有 templateId，雇佣后多出 agentId，两者必须解析到同一个 key
    expect(resolveLikeKey({ id: 'tpl-01' })).toBe('tpl-01');
    expect(resolveLikeKey({ id: 'tpl-01', agentId: 'agent-99' })).toBe('tpl-01');
  });

  it('id 缺失时退回 agentId', () => {
    expect(resolveLikeKey({ agentId: 'agent-99' })).toBe('agent-99');
  });

  it('id 为空串时不产生空 key', () => {
    expect(resolveLikeKey({ id: '', agentId: 'agent-99' })).toBe('agent-99');
  });

  it('两者皆空返回空串，交由调用方禁用交互', () => {
    expect(resolveLikeKey({})).toBe('');
    expect(resolveLikeKey({ id: '', agentId: '' })).toBe('');
  });
});

describe('likesStore', () => {
  beforeEach(() => {
    db.clear();
    failNextToggle = false;
    useLikesStore.setState({ likes: {}, toggling: {}, error: null });
  });

  it('hydrate 加载点赞状态（无记录 count=0）', async () => {
    const rec = await useLikesStore.getState().hydrate('agent-01');
    expect(rec.count).toBe(0);
    expect(rec.likedByMe).toBe(false);
    expect(useLikesStore.getState().likes['agent-01'].count).toBe(0);
  });

  it('toggle 乐观更新：立即点赞 +1，再点取消 -1', async () => {
    const s = useLikesStore.getState();
    await s.hydrate('agent-01');
    // 点赞：乐观态立即生效
    const liked = await s.toggle('agent-01');
    expect(liked.likedByMe).toBe(true);
    expect(liked.count).toBe(1);
    // 取消：回到 0
    const unliked = await useLikesStore.getState().toggle('agent-01');
    expect(unliked.likedByMe).toBe(false);
    expect(unliked.count).toBe(0);
  });

  it('toggle 落库失败回滚到 toggle 前状态', async () => {
    const s = useLikesStore.getState();
    await s.hydrate('agent-02');
    failNextToggle = true;
    const prev = useLikesStore.getState().likes['agent-02'];
    await s.toggle('agent-02');
    const after = useLikesStore.getState().likes['agent-02'];
    expect(after.likedByMe).toBe(prev.likedByMe);
    expect(after.count).toBe(prev.count);
    expect(useLikesStore.getState().error).toContain('回滚');
  });

  it('toggle 防连点：进行中重复调用返回当前状态且不重复落库', async () => {
    const s = useLikesStore.getState();
    await s.hydrate('agent-03');
    // 首次调用进行中（模拟）
    useLikesStore.setState({ toggling: { 'agent-03': true } });
    const during = await s.toggle('agent-03');
    expect(during.likedByMe).toBe(false); // 未变化
    useLikesStore.setState({ toggling: {} });
  });

  it('空 key 静默返回而不抛错（调用方为 void toggle）', async () => {
    await expect(useLikesStore.getState().toggle('')).resolves.toMatchObject({
      count: 0,
      likedByMe: false,
    });
  });

  it('clearError 清空错误', () => {
    useLikesStore.setState({ error: 'x' });
    useLikesStore.getState().clearError();
    expect(useLikesStore.getState().error).toBeNull();
  });
});
