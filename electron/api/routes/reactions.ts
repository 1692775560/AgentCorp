/**
 * electron/api/routes/reactions.ts
 * 小红心点赞 + BossFavorite 的 Host API 本地实现（T01 / 契约 §1.4/§1.5）。
 *
 * 路由：
 *   GET  /api/likes/:agentId        → LikeRecord（无记录 count=0）
 *   POST /api/likes/:agentId/toggle → 最新 LikeRecord（个人态翻转 + 计数 ±1）
 *   GET  /api/favorites?jobType=    → FavoriteRanking（按 count 降序）
 *   POST /api/favorites/vote        → FavoriteVoteResult（幂等：同 agent+stage+sourceId 409）
 *
 * 存储：electron-store 命名空间 `agentcorp.reactions`（主进程直接读写，
 * 与渲染层 reactionStore 共用同一命名空间）。
 *
 * 跨用户聚合：配置 AGENTCORP_REACTIONS_API 后，count 以远端聚合值为准
 * （read-through），likedByMe 始终取本地态。远端不可用则纯本地降级，
 * 交互不受影响。详见 electron/api/reactions-remote.ts。
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendJson } from '../route-utils';
import type { HostApiContext } from '../context';
import {
  deriveVoterId,
  fetchRemoteFavorites,
  fetchRemoteLike,
  isRemoteEnabled,
  mergeLikeCount,
  pushRemoteFavorite,
  pushRemoteLike,
} from '../reactions-remote';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let reactionStoreInstance: any = null;

async function getReactionStore() {
  if (!reactionStoreInstance) {
    const Store = (await import('electron-store')).default;
    reactionStoreInstance = new Store({ name: 'agentcorp.reactions' });
  }
  return reactionStoreInstance;
}

interface LikeRecord {
  agentId: string;
  count: number;
  likedByMe: boolean;
  users?: string[];
  updatedAt: string;
}

interface FavoriteAggregate {
  count: number;
  voters: string[];
  updatedAt: string;
}

interface BossFavoriteVote {
  agentId: string;
  jobType: string;
  votedBy: string;
  stage: string;
  sourceId?: string;
  ts: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function favKey(jobType: string, agentId: string): string {
  return `${jobType}:${agentId}`;
}

/**
 * 本机稳定的匿名投票者标识，落在 reactions store 的 `voterSeed` 键。
 *
 * 用随机 UUID 而非设备指纹：远端只需要「同一台机器是同一个人」，
 * 不需要能反查设备。首次生成后持久化，重启保持一致，否则会重复计数。
 */
async function getVoterId(): Promise<string> {
  const store = await getReactionStore();
  let seed = store.get('voterSeed') as string | undefined;
  if (!seed) {
    seed = randomUUID();
    store.set('voterSeed', seed);
  }
  return deriveVoterId(seed);
}

async function readShape() {
  const store = await getReactionStore();
  const raw = (store.store ?? {}) as Record<string, unknown>;
  return {
    likes: (raw.likes ?? {}) as Record<string, LikeRecord>,
    favorites: (raw.favorites ?? {}) as Record<string, FavoriteAggregate>,
    votes: (Array.isArray(raw.votes) ? raw.votes : []) as BossFavoriteVote[],
  };
}

async function writeShape(shape: {
  likes: Record<string, LikeRecord>;
  favorites: Record<string, FavoriteAggregate>;
  votes: BossFavoriteVote[];
}): Promise<void> {
  const store = await getReactionStore();
  store.set('likes', shape.likes);
  store.set('favorites', shape.favorites);
  store.set('votes', shape.votes);
}

/** GET /api/likes/:agentId */
async function handleGetLike(agentId: string, res: ServerResponse): Promise<void> {
  if (!agentId) {
    sendJson(res, 400, { success: false, error: 'agentId 不能为空' });
    return;
  }
  const shape = await readShape();
  const local = shape.likes[agentId] ?? {
    agentId,
    count: 0,
    likedByMe: false,
    users: [],
    updatedAt: nowIso(),
  };
  // 远端为跨用户 count 的权威来源；likedByMe 只有本地知道
  const remote = isRemoteEnabled() ? await fetchRemoteLike(agentId) : null;
  sendJson(res, 200, {
    ...local,
    count: mergeLikeCount(local.count, remote),
    remote: remote !== null,
  });
}

/** POST /api/likes/:agentId/toggle */
async function handleToggleLike(agentId: string, res: ServerResponse): Promise<void> {
  if (!agentId) {
    sendJson(res, 400, { success: false, error: 'agentId 不能为空' });
    return;
  }
  const shape = await readShape();
  const prev = shape.likes[agentId] ?? {
    agentId,
    count: 0,
    likedByMe: false,
    users: [],
    updatedAt: '',
  };
  const next: LikeRecord = {
    agentId,
    count: prev.likedByMe ? Math.max(0, prev.count - 1) : prev.count + 1,
    likedByMe: !prev.likedByMe,
    users: prev.users ?? [],
    updatedAt: nowIso(),
  };
  shape.likes[agentId] = next;
  await writeShape(shape);

  // 本地写入已完成，远端上报失败不回滚：宁可远端少一票，也不让用户的点赞失效
  if (isRemoteEnabled()) {
    const voterId = await getVoterId();
    const remote = await pushRemoteLike(agentId, next.likedByMe ? 1 : -1, voterId);
    sendJson(res, 200, {
      ...next,
      count: mergeLikeCount(next.count, remote),
      remote: remote !== null,
    });
    return;
  }
  sendJson(res, 200, { ...next, remote: false });
}

/** GET /api/favorites?jobType= */
async function handleGetFavorites(jobType: string | null, res: ServerResponse): Promise<void> {
  const VALID_JOBS = new Set(['code', 'text', 'image']);
  if (!jobType || !VALID_JOBS.has(jobType)) {
    sendJson(res, 422, { success: false, error: `非法 jobType：${jobType ?? '(空)'}` });
    return;
  }
  const shape = await readShape();
  const ranking = Object.entries(shape.favorites)
    .filter(([key]) => key.startsWith(`${jobType}:`))
    .map(([key, agg]) => ({
      agentId: key.slice(jobType.length + 1),
      count: agg.count,
      voters: agg.voters ?? [],
    }))
    .sort((a, b) => b.count - a.count);

  // 远端可用时以远端榜为准（本地榜只反映本机投票，跨用户无意义）
  const remote = isRemoteEnabled() ? await fetchRemoteFavorites(jobType) : null;
  if (remote) {
    sendJson(res, 200, {
      jobType,
      ranking: remote
        .map((e) => ({ agentId: e.agentId, count: e.count, voters: [] as string[] }))
        .sort((a, b) => b.count - a.count),
      remote: true,
    });
    return;
  }
  sendJson(res, 200, { jobType, ranking, remote: false });
}

/** POST /api/favorites/vote */
async function handleVoteFavorite(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody<{
    agentId?: string;
    jobType?: string;
    stage?: string;
    sourceId?: string;
    votedBy?: string;
  }>(req);
  if (!body.agentId || !body.jobType) {
    sendJson(res, 422, { success: false, error: 'agentId 与 jobType 必填' });
    return;
  }
  const VALID_JOBS = new Set(['code', 'text', 'image']);
  if (!VALID_JOBS.has(body.jobType)) {
    sendJson(res, 422, { success: false, error: `非法 jobType：${body.jobType}` });
    return;
  }
  const stage = body.stage ?? 'arena';
  const votedBy = body.votedBy ?? 'default';
  const sourceId = body.sourceId ?? undefined;

  const shape = await readShape();
  if (sourceId) {
    const dup = shape.votes.some(
      (v) =>
        v.agentId === body.agentId &&
        v.stage === stage &&
        v.sourceId === sourceId &&
        v.votedBy === votedBy,
    );
    if (dup) {
      sendJson(res, 409, { success: false, error: '该测评已投过票' });
      return;
    }
  }
  const key = favKey(body.jobType, body.agentId);
  const agg: FavoriteAggregate = shape.favorites[key] ?? {
    count: 0,
    voters: [],
    updatedAt: nowIso(),
  };
  agg.count += 1;
  if (!agg.voters.includes(votedBy)) agg.voters.push(votedBy);
  agg.updatedAt = nowIso();
  shape.favorites[key] = agg;
  shape.votes.push({
    agentId: body.agentId,
    jobType: body.jobType,
    votedBy,
    stage,
    sourceId,
    ts: nowIso(),
  });
  await writeShape(shape);

  let count = agg.count;
  let remoteOk = false;
  if (isRemoteEnabled()) {
    const voterId = await getVoterId();
    const remote = await pushRemoteFavorite({
      agentId: body.agentId,
      jobType: body.jobType,
      stage,
      sourceId,
      voterId,
    });
    if (remote && typeof remote.count === 'number') {
      count = remote.count;
      remoteOk = true;
    }
  }
  sendJson(res, 200, {
    agentId: body.agentId,
    jobType: body.jobType,
    count,
    voted: true,
    remote: remoteOk,
  });
}

export async function handleReactionsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  const likeMatch = url.pathname.match(/^\/api\/likes\/([^/]+)$/);
  if (likeMatch && req.method === 'GET') {
    await handleGetLike(decodeURIComponent(likeMatch[1]), res);
    return true;
  }
  const toggleMatch = url.pathname.match(/^\/api\/likes\/([^/]+)\/toggle$/);
  if (toggleMatch && req.method === 'POST') {
    await handleToggleLike(decodeURIComponent(toggleMatch[1]), res);
    return true;
  }
  if (url.pathname === '/api/favorites' && req.method === 'GET') {
    await handleGetFavorites(url.searchParams.get('jobType'), res);
    return true;
  }
  if (url.pathname === '/api/favorites/vote' && req.method === 'POST') {
    await handleVoteFavorite(req, res);
    return true;
  }
  return false;
}
