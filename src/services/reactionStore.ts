/**
 * src/services/reactionStore.ts
 * 小红心点赞 + BossFavorite 本地落库（electron-store，模块 Arena · 设计 §4/§5）。
 *
 * 命名空间：`agentcorp.reactions`（默认落盘 <userData>/agentcorp.reactions.json）。
 * 存储结构：
 *   {
 *     likes: { [agentId]: LikeRecord },
 *     favorites: { [`${jobType}:${agentId}`]: FavoriteAggregate },
 *     votes: BossFavoriteVote[]   // 幂等校验用（同 agent+stage+sourceId 不重复）
 *   }
 *
 * 沿用 services/interviewStore.ts 的 lazy-load 模式（动态 import electron-store），
 * 避免渲染层打包期解析 Node 模块。与 Host API 路由（electron/api/routes/reactions.ts）
 * 共用同一命名空间。
 *
 * 读写分层（跨用户聚合）：
 *   `*Local` 系列 —— 直接读写 electron-store，仅本机视角，离线兜底。
 *   无后缀导出   —— 优先走 Host API（主进程会叠加远端跨用户 count），
 *                   Host API 不可用时自动回落到 `*Local`。
 * UI 一律用无后缀版本，才能看到「多少人喜欢」而非「我点过几次」。
 */
import { hostApiFetch } from '@/lib/host-api';
import type { JobType } from '@/types/evaluation';
import type {
  BossFavoriteVote,
  FavoriteAggregate,
  FavoriteRanking,
  FavoriteVoteInput,
  FavoriteVoteResult,
  LikeRecord,
} from '@/types/reactions';

// Lazy-load electron-store（ESM module），与 interviewStore.ts 保持一致。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let reactionStoreInstance: any = null;

interface ReactionsShape {
  likes: Record<string, LikeRecord>;
  favorites: Record<string, FavoriteAggregate>;
  votes: BossFavoriteVote[];
}

function favKey(jobType: JobType, agentId: string): string {
  return `${jobType}:${agentId}`;
}

/** 读取完整存储（缺键补默认，防旧数据损坏） */
async function readShape(): Promise<ReactionsShape> {
  const store = await getReactionStore();
  const raw = (store.store ?? {}) as Partial<ReactionsShape>;
  return {
    likes: raw.likes ?? {},
    favorites: raw.favorites ?? {},
    votes: Array.isArray(raw.votes) ? raw.votes : [],
  };
}

/** 覆盖写完整存储 */
async function writeShape(shape: ReactionsShape): Promise<void> {
  const store = await getReactionStore();
  store.set('likes', shape.likes);
  store.set('favorites', shape.favorites);
  store.set('votes', shape.votes);
}

async function getReactionStore() {
  if (!reactionStoreInstance) {
    const Store = (await import('electron-store')).default;
    reactionStoreInstance = new Store({ name: 'agentcorp.reactions' });
  }
  return reactionStoreInstance;
}

/** 读取某 agent 的点赞记录；无记录返回 count=0 的默认态。 */
export async function getLikeLocal(agentId: string): Promise<LikeRecord> {
  const shape = await readShape();
  return (
    shape.likes[agentId] ?? {
      agentId,
      count: 0,
      likedByMe: false,
      users: [],
      updatedAt: new Date().toISOString(),
    }
  );
}

/** toggle 点赞：个人态翻转 + 计数 ±1（幂等：连续 toggle 正常翻转）。 */
export async function toggleLikeLocal(agentId: string): Promise<LikeRecord> {
  if (!agentId) throw new Error('agentId 不能为空');
  const shape = await readShape();
  const prev =
    shape.likes[agentId] ??
    ({ agentId, count: 0, likedByMe: false, users: [], updatedAt: '' } as LikeRecord);
  const next: LikeRecord = {
    agentId,
    count: prev.likedByMe ? Math.max(0, prev.count - 1) : prev.count + 1,
    likedByMe: !prev.likedByMe,
    users: prev.users ?? [],
    updatedAt: new Date().toISOString(),
  };
  shape.likes[agentId] = next;
  await writeShape(shape);
  return next;
}

/** 按工种读取青睐榜（按 count 降序，voters 预留）。 */
export async function getFavoritesLocal(jobType: JobType): Promise<FavoriteRanking> {
  const shape = await readShape();
  const entries = Object.entries(shape.favorites)
    .filter(([key]) => key.startsWith(`${jobType}:`))
    .map(([key, agg]) => ({
      agentId: key.slice(jobType.length + 1),
      count: agg.count,
      voters: agg.voters ?? [],
    }))
    .sort((a, b) => b.count - a.count);
  return { jobType, ranking: entries };
}

/**
 * BossFavorite 投票：本地落库 + 幂等校验。
 * 同 agent + stage + sourceId 重复投票抛 409（与契约一致，前端据此提示）。
 * 未传 sourceId 时不做幂等限制（仅计数）。
 */
export async function voteFavoriteLocal(input: FavoriteVoteInput): Promise<FavoriteVoteResult> {
  if (!input.agentId || !input.jobType) {
    throw new Error('agentId 与 jobType 不能为空');
  }
  const shape = await readShape();
  const votedBy = input.votedBy ?? 'default';
  if (input.sourceId) {
    const dup = shape.votes.some(
      (v) =>
        v.agentId === input.agentId &&
        v.stage === input.stage &&
        v.sourceId === input.sourceId &&
        v.votedBy === votedBy,
    );
    if (dup) {
      const err = new Error('该测评已投过票') as Error & { status?: number };
      err.status = 409;
      throw err;
    }
  }
  const key = favKey(input.jobType, input.agentId);
  const agg: FavoriteAggregate = shape.favorites[key] ?? {
    count: 0,
    voters: [],
    updatedAt: new Date().toISOString(),
  };
  agg.count += 1;
  if (!agg.voters.includes(votedBy)) agg.voters.push(votedBy);
  agg.updatedAt = new Date().toISOString();
  shape.favorites[key] = agg;
  shape.votes.push({
    agentId: input.agentId,
    jobType: input.jobType,
    votedBy,
    stage: input.stage,
    sourceId: input.sourceId,
    ts: new Date().toISOString(),
  });
  await writeShape(shape);
  return { agentId: input.agentId, jobType: input.jobType, count: agg.count, voted: true };
}

// ── Host API 优先的对外接口（UI 使用这一组）────────────────────────
//
// Host API 会在主进程叠加远端跨用户聚合，因此 count 才是「多少人喜欢」。
// 任何失败（Host 未启动、远端不可用、网络错）都回落本地，交互不中断。

/** 重复投票的错误文案，与 electron/api/routes/reactions.ts 的 409 响应体一致。 */
const DUPLICATE_VOTE_MESSAGE = '该测评已投过票';

/** 读取点赞态：优先跨用户聚合，失败回落本机。 */
export async function getLike(agentId: string): Promise<LikeRecord> {
  try {
    return await hostApiFetch<LikeRecord>(
      `/api/likes/${encodeURIComponent(agentId)}`,
    );
  } catch {
    return getLikeLocal(agentId);
  }
}

/** 翻转点赞：优先经 Host API 上报（含远端聚合），失败回落本机。 */
export async function toggleLike(agentId: string): Promise<LikeRecord> {
  try {
    return await hostApiFetch<LikeRecord>(
      `/api/likes/${encodeURIComponent(agentId)}/toggle`,
      { method: 'POST' },
    );
  } catch {
    return toggleLikeLocal(agentId);
  }
}

/** 青睐榜：优先跨用户榜，失败回落本机榜。 */
export async function getFavorites(jobType: JobType): Promise<FavoriteRanking> {
  try {
    return await hostApiFetch<FavoriteRanking>(
      `/api/favorites?jobType=${encodeURIComponent(jobType)}`,
    );
  } catch {
    return getFavoritesLocal(jobType);
  }
}

/**
 * BossFavorite 投票：优先经 Host API。
 *
 * 409 必须透出给调用方，不能当成传输失败去回落本地 —— 否则会绕过服务端幂等再记一票。
 * hostApiFetch 会把 409 响应体的 error 字段抛成 Error(message)，据此识别。
 */
export async function voteFavorite(input: FavoriteVoteInput): Promise<FavoriteVoteResult> {
  try {
    return await hostApiFetch<FavoriteVoteResult>('/api/favorites/vote', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    if (message.includes(DUPLICATE_VOTE_MESSAGE)) {
      const err = new Error(DUPLICATE_VOTE_MESSAGE) as Error & { status?: number };
      err.status = 409;
      throw err;
    }
    return voteFavoriteLocal(input);
  }
}

export const reactionStore = { getLike, toggleLike, getFavorites, voteFavorite };
