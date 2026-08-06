/**
 * src/services/convergenceService.ts
 * Layer3 收敛层网络 + 本地缓存服务（T17）。
 *
 * 网络：经 Host API 代理（与 judgeClient 同基 `hostApiFetch`）调用
 *   model-service 的 /api/convergence/{trace,score,anchor} 端点（T16）。
 *   契约严格对齐 serve.py，snake_case（与既有 evaluation.ts 一致）。
 *
 * 本地缓存：electron-store 命名空间 `agentcorp.convergence`
 *   （<userData>/agentcorp.convergence.json）。
 *   - traces：run_id → ConvergenceTrace
 *   - anchors：anchor_id → HumanAnchor
 *   沿用 electron/utils/store.ts 的 lazy-load 模式（动态 import electron-store），
 *   避免渲染层打包期解析 Node 模块。
 */
import { hostApiFetch } from '@/lib/host-api';
import type {
  ConvergenceTrace,
  ConvergenceScore,
  HumanAnchor,
} from '@/types/convergence';

const BASE = '/api/convergence';

// ---- electron-store（惰性，与 evaluationStore 同模式）----
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let convStoreInstance: any = null;

async function getConvergenceStore() {
  if (!convStoreInstance) {
    const Store = (await import('electron-store')).default;
    convStoreInstance = new Store({ name: 'agentcorp.convergence' });
  }
  return convStoreInstance;
}

/** 缓存一条轨迹（traces.<run_id>） */
export async function cacheTrace(trace: ConvergenceTrace): Promise<void> {
  try {
    const store = await getConvergenceStore();
    store.set(`traces.${trace.run_id}`, trace);
  } catch {
    // 缓存失败不影响主流程
  }
}

/** 读取缓存轨迹 */
export async function readCachedTrace(
  runId: string,
): Promise<ConvergenceTrace | undefined> {
  try {
    const store = await getConvergenceStore();
    return store.get(`traces.${runId}`) as ConvergenceTrace | undefined;
  } catch {
    return undefined;
  }
}

/** 缓存一个锚点（anchors.<anchor_id>） */
export async function cacheAnchor(anchor: HumanAnchor): Promise<void> {
  try {
    const store = await getConvergenceStore();
    store.set(`anchors.${anchor.anchor_id}`, anchor);
  } catch {
    // 缓存失败不影响主流程
  }
}

// ======================================================================
// 网络调用（T16 端点）
// ======================================================================

/** POST /api/convergence/trace —— 记录一次收敛轨迹，返回 run_id。 */
export async function postTrace(
  trace: ConvergenceTrace,
): Promise<{ run_id: string }> {
  const res = await hostApiFetch<{ run_id: string }>(`${BASE}/trace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(trace),
  });
  await cacheTrace(trace);
  return res;
}

/** POST /api/convergence/score —— 由 run_id 或完整 trace 计算收敛分。 */
export async function postScore(
  req: { run_id: string } | { trace: ConvergenceTrace },
): Promise<ConvergenceScore> {
  return hostApiFetch<ConvergenceScore>(`${BASE}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

/** GET /api/convergence/anchor?ownerId= —— 列出锚点（可按 owner 过滤）。 */
export async function getAnchors(
  ownerId?: string,
): Promise<HumanAnchor[]> {
  const qs = ownerId ? `?ownerId=${encodeURIComponent(ownerId)}` : '';
  return hostApiFetch<HumanAnchor[]>(`${BASE}/anchor${qs}`, { method: 'GET' });
}

/** POST /api/convergence/anchor —— 写入锚点，返回 {ok, anchor_id}。 */
export async function postAnchor(
  anchor: HumanAnchor,
): Promise<{ ok: boolean; anchor_id: string }> {
  const res = await hostApiFetch<{ ok: boolean; anchor_id: string }>(
    `${BASE}/anchor`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(anchor),
    },
  );
  await cacheAnchor(anchor);
  return res;
}

export const convergenceService = {
  postTrace,
  postScore,
  getAnchors,
  postAnchor,
  cacheTrace,
  cacheAnchor,
  readCachedTrace,
};
