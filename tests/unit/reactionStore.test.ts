/**
 * tests/unit/reactionStore.test.ts
 *
 * 小红心点赞 + BossFavorite 本地落库单测（T01）。
 * - reactionStore（渲染层 electron-store lazy-load）：
 *   - getLike 无记录返回 count=0 默认态
 *   - toggleLike 幂等翻转（个人态 + 计数 ±1）
 *   - getFavorites 按工种聚合、count 降序
 *   - voteFavorite 幂等（同 agent+stage+sourceId 抛 409），未传 sourceId 不限制
 *   - 存储结构 { likes, favorites, votes } 保持
 *
 * 隔离：mock 'electron-store'（in-memory FakeStore），与 eval-stores.test.ts 同模式。
 * 每次 beforeEach 执行 vi.resetModules() + 动态 import，确保模块级单例
 * reactionStoreInstance 重建（FakeStore 实例随之重置），测试互不污染。
 * 运行：pnpm test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron-store', () => {
  class FakeStore {
    private data = new Map<string, any>();
    constructor(_opts?: any) {}
    set(key: string, val: any) {
      this.data.set(key, val);
    }
    get(key: string) {
      return this.data.get(key);
    }
    get store() {
      return Object.fromEntries(this.data);
    }
  }
  return { default: FakeStore };
});

type ReactionStoreModule = typeof import('@/services/reactionStore');
type FavoriteVoteInput = import('@/types/reactions').FavoriteVoteInput;

let reactionStore: ReactionStoreModule;

async function expectReject409(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    expect.unreachable('应当抛出 409 错误');
  } catch (err) {
    expect((err as Error & { status?: number }).status).toBe(409);
  }
}

describe('reactionStore.likes', () => {
  beforeEach(async () => {
    vi.resetModules();
    reactionStore = await import('@/services/reactionStore');
  });

  it('无记录返回 count=0 默认态', async () => {
    const rec = await reactionStore.getLike('agent-01');
    expect(rec.agentId).toBe('agent-01');
    expect(rec.count).toBe(0);
    expect(rec.likedByMe).toBe(false);
    expect(rec.users).toEqual([]);
    expect(typeof rec.updatedAt).toBe('string');
  });

  it('toggleLike 幂等翻转：点赞 +1，取消 -1', async () => {
    const liked = await reactionStore.toggleLike('agent-01');
    expect(liked.likedByMe).toBe(true);
    expect(liked.count).toBe(1);

    const unliked = await reactionStore.toggleLike('agent-01');
    expect(unliked.likedByMe).toBe(false);
    expect(unliked.count).toBe(0);
  });

  it('toggleLike 拒绝空 agentId', async () => {
    await expect(reactionStore.toggleLike('')).rejects.toThrow(/agentId/);
  });

  it('重复 toggle 后 getLike 反映持久化状态', async () => {
    await reactionStore.toggleLike('agent-02');
    await reactionStore.toggleLike('agent-02');
    await reactionStore.toggleLike('agent-02');
    const rec = await reactionStore.getLike('agent-02');
    expect(rec.count).toBe(1);
    expect(rec.likedByMe).toBe(true);
  });
});

describe('reactionStore.favorites', () => {
  beforeEach(async () => {
    vi.resetModules();
    reactionStore = await import('@/services/reactionStore');
  });

  it('getFavorites 空工种返回空榜', async () => {
    const ranking = await reactionStore.getFavorites('code');
    expect(ranking.jobType).toBe('code');
    expect(ranking.ranking).toEqual([]);
  });

  it('voteFavorite 计数 +1 并按 count 降序', async () => {
    await reactionStore.voteFavorite({
      agentId: 'a1',
      jobType: 'code',
      stage: 'arena',
      sourceId: 'm1',
    });
    await reactionStore.voteFavorite({
      agentId: 'a2',
      jobType: 'code',
      stage: 'arena',
      sourceId: 'm2',
    });
    await reactionStore.voteFavorite({
      agentId: 'a2',
      jobType: 'code',
      stage: 'arena',
      sourceId: 'm3',
    });

    const ranking = await reactionStore.getFavorites('code');
    expect(ranking.ranking).toHaveLength(2);
    expect(ranking.ranking[0].agentId).toBe('a2');
    expect(ranking.ranking[0].count).toBe(2);
    expect(ranking.ranking[1].agentId).toBe('a1');
    expect(ranking.ranking[1].count).toBe(1);
  });

  it('voteFavorite 幂等：同 agent+stage+sourceId 重复投抛 409', async () => {
    const input: FavoriteVoteInput = {
      agentId: 'a1',
      jobType: 'code',
      stage: 'arena',
      sourceId: 'match-1',
    };
    await reactionStore.voteFavorite(input);
    await expectReject409(reactionStore.voteFavorite(input));
    // 不影响计数
    const ranking = await reactionStore.getFavorites('code');
    expect(ranking.ranking[0].count).toBe(1);
  });

  it('voteFavorite 不同 stage 或不同 sourceId 允许重复投', async () => {
    const base = { agentId: 'a1', jobType: 'code' } as const;
    await reactionStore.voteFavorite({ ...base, stage: 'arena', sourceId: 'm1' });
    await reactionStore.voteFavorite({ ...base, stage: 'interview', sourceId: 'm1' }); // 不同 stage
    await reactionStore.voteFavorite({ ...base, stage: 'arena', sourceId: 'm2' }); // 不同 sourceId
    const ranking = await reactionStore.getFavorites('code');
    expect(ranking.ranking[0].count).toBe(3);
  });

  it('voteFavorite 未传 sourceId 不限制次数（仅计数）', async () => {
    await reactionStore.voteFavorite({ agentId: 'a9', jobType: 'text', stage: 'arena' });
    await reactionStore.voteFavorite({ agentId: 'a9', jobType: 'text', stage: 'arena' });
    const ranking = await reactionStore.getFavorites('text');
    expect(ranking.ranking[0].count).toBe(2);
  });

  it('voteFavorite 缺参拒绝', async () => {
    await expect(
      reactionStore.voteFavorite({ agentId: '', jobType: 'code', stage: 'arena' }),
    ).rejects.toThrow(/agentId/);
    await expect(
      reactionStore.voteFavorite({ agentId: 'a1', jobType: '' as never, stage: 'arena' }),
    ).rejects.toThrow(/jobType/);
  });

  it('getFavorites 按工种隔离', async () => {
    await reactionStore.voteFavorite({
      agentId: 'a1',
      jobType: 'code',
      stage: 'arena',
      sourceId: 'c1',
    });
    await reactionStore.voteFavorite({
      agentId: 'a1',
      jobType: 'text',
      stage: 'arena',
      sourceId: 't1',
    });
    const code = await reactionStore.getFavorites('code');
    const text = await reactionStore.getFavorites('text');
    expect(code.ranking[0].agentId).toBe('a1');
    expect(text.ranking[0].agentId).toBe('a1');
    expect(code.ranking).toHaveLength(1);
    expect(text.ranking).toHaveLength(1);
  });
});
