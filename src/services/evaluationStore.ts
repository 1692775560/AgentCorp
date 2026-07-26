/**
 * src/services/evaluationStore.ts
 * 评估档案本地落库（electron-store）。
 *
 * 命名空间：`agentcorp.evaluation`（默认落盘 <userData>/agentcorp.evaluation.json）。
 * 键 = agentId，值 = EvaluationProfile。与 ClawCorp 既有 `settings` store 隔离
 * （见 docs/architecture-pivot.md §2.D / §3 / §8）。
 *
 * 沿用 electron/utils/store.ts 的 lazy-load 模式（动态 import electron-store），
 * 避免渲染层打包期解析 Node 模块，并确保仅在 Runtime 可用时初始化。
 */

import type { EvaluationProfile } from '@/types/evaluation';

// Lazy-load electron-store（ESM module），与 electron/utils/store.ts 保持一致。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let evaluationStoreInstance: any = null;

/**
 * 获取（惰性初始化）评估档案 store 实例。
 */
async function getEvaluationStore() {
  if (!evaluationStoreInstance) {
    const Store = (await import('electron-store')).default;
    evaluationStoreInstance = new Store<EvaluationProfile>({
      name: 'agentcorp.evaluation',
    });
  }
  return evaluationStoreInstance;
}

/**
 * 保存（覆盖写）某个 agent 的评估档案。
 * @param profile 评估档案（以 profile.agentId 为键）
 */
export async function save(profile: EvaluationProfile): Promise<void> {
  const store = await getEvaluationStore();
  store.set(profile.agentId, profile);
}

/**
 * 按 agentId 读取评估档案。
 * @returns 命中则返回 EvaluationProfile，否则 undefined。
 */
export async function load(agentId: string): Promise<EvaluationProfile | undefined> {
  const store = await getEvaluationStore();
  return store.get(agentId) as EvaluationProfile | undefined;
}

/**
 * 列出全部评估档案。
 * 过滤 electron-store 内部迁移键（`__internal__`），仅返回 EvaluationProfile。
 */
export async function list(): Promise<EvaluationProfile[]> {
  const store = await getEvaluationStore();
  const all = store.store as Record<string, EvaluationProfile>;
  return Object.values(all).filter(
    (value): value is EvaluationProfile =>
      !!value && typeof value === 'object' && 'agentId' in value,
  );
}
