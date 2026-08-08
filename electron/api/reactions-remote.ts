/**
 * electron/api/reactions-remote.ts
 * 跨用户点赞/青睐的远端同步层（接口层，供协作者接后端）。
 *
 * 定位：本文件只负责「与远端聚合服务通信」这一件事，不碰本地存储。
 * electron/api/routes/reactions.ts 保持本地 electron-store 为写入真相，
 * 远端仅提供跨用户 count 的聚合视图（read-through）与投票上报（write-behind）。
 *
 * 为什么放在主进程：远端调用需要设备身份签名与 API 凭据，两者都不能进渲染层。
 *
 * 启用方式（未配置时全部降级为 null，调用方回落本地计数，功能不受影响）：
 *   AGENTCORP_REACTIONS_API=https://api.example.com/v1
 *   AGENTCORP_REACTIONS_TOKEN=<bearer token>   // 可选
 *
 * 协作者后续要做的事集中在三处，已用 TODO(collab) 标注：
 *   1. 真实鉴权（当前仅 Bearer，需要换成设备签名 + 服务端校验）
 *   2. 服务端去重（当前 voterId 由客户端给出，可被伪造刷量）
 *   3. 离线补偿（当前上报失败即丢弃，需要落盘重试队列）
 */
import { createHash } from 'node:crypto';

/** 远端聚合的点赞数（跨用户）。likedByMe 由本地态决定，不从远端取。 */
export interface RemoteLikeAggregate {
  agentId: string;
  count: number;
  updatedAt: string;
}

export interface RemoteFavoriteEntry {
  agentId: string;
  count: number;
}

const TIMEOUT_MS = 8_000;

/** 远端未配置时返回 null，调用方据此走纯本地路径。 */
function baseUrl(): string | null {
  const raw = process.env.AGENTCORP_REACTIONS_API?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    // 仅允许 https，避免凭据走明文；localhost 放开以便协作者本地联调
    const isLocal = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (u.protocol !== 'https:' && !isLocal) return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function isRemoteEnabled(): boolean {
  return baseUrl() !== null;
}

/**
 * 匿名投票者标识：设备指纹哈希后取前 16 位。
 *
 * 不直接用 deviceId 原值，避免把设备指纹泄露给远端做跨服务追踪。
 * 加盐固定字符串而非随机值，保证同一设备重启后仍是同一 voterId（否则会重复计数）。
 */
export function deriveVoterId(deviceId: string): string {
  if (!deviceId) return 'anonymous';
  return createHash('sha256').update(`agentcorp:voter:${deviceId}`).digest('hex').slice(0, 16);
}

async function remoteFetch<T>(path: string, init?: RequestInit): Promise<T | null> {
  const base = baseUrl();
  if (!base) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init?.body) headers['content-type'] = 'application/json';
    // TODO(collab): 换成设备签名鉴权（复用 electron/utils/device-identity.ts 的
    // signDevicePayload），Bearer token 仅够本地联调。
    const token = process.env.AGENTCORP_REACTIONS_TOKEN?.trim();
    if (token) headers.authorization = `Bearer ${token}`;

    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // 远端不可用不应该阻塞本地交互，静默降级
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取远端跨用户点赞数；不可用返回 null。 */
export async function fetchRemoteLike(agentId: string): Promise<RemoteLikeAggregate | null> {
  if (!agentId) return null;
  return remoteFetch<RemoteLikeAggregate>(`/likes/${encodeURIComponent(agentId)}`);
}

/**
 * 上报一次点赞翻转。delta 为 +1/-1，由本地翻转结果决定。
 * 返回远端最新计数；失败返回 null（本地计数已生效，不回滚）。
 */
export async function pushRemoteLike(
  agentId: string,
  delta: 1 | -1,
  voterId: string,
): Promise<RemoteLikeAggregate | null> {
  if (!agentId) return null;
  // TODO(collab): 服务端必须以 voterId 做幂等与去重，否则客户端可反复 +1 刷量。
  // TODO(collab): 失败时应入盘重试队列，当前直接丢弃这次上报。
  return remoteFetch<RemoteLikeAggregate>(`/likes/${encodeURIComponent(agentId)}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ delta, voterId }),
  });
}

/** 拉取远端工种青睐榜；不可用返回 null。 */
export async function fetchRemoteFavorites(
  jobType: string,
): Promise<RemoteFavoriteEntry[] | null> {
  const data = await remoteFetch<{ ranking?: RemoteFavoriteEntry[] }>(
    `/favorites?jobType=${encodeURIComponent(jobType)}`,
  );
  return data?.ranking ?? null;
}

/** 上报一次 BossFavorite 投票。 */
export async function pushRemoteFavorite(input: {
  agentId: string;
  jobType: string;
  stage: string;
  sourceId?: string;
  voterId: string;
}): Promise<RemoteFavoriteEntry | null> {
  if (!input.agentId || !input.jobType) return null;
  return remoteFetch<RemoteFavoriteEntry>('/favorites/vote', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * 合并本地与远端计数。
 *
 * 远端为权威 count（跨用户），本地只贡献 likedByMe。远端不可用时返回本地 count，
 * 保证离线可用。远端 count 小于本地时取远端 —— 本地计数是单机自增，
 * 在多设备场景下必然偏大，以远端为准才是真实人气。
 */
export function mergeLikeCount(
  localCount: number,
  remote: RemoteLikeAggregate | null,
): number {
  if (!remote || typeof remote.count !== 'number' || Number.isNaN(remote.count)) {
    return localCount;
  }
  return Math.max(0, remote.count);
}
