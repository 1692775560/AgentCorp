/**
 * src/services/evaluationStore.ts
 * 评估档案本地落库（electron-store）。
 *
 * 命名空间：`agentcorp.evaluation`（默认落盘 <userData>/agentcorp.evaluation.json）。
 * 键 = agentId，值 = EvaluationProfile。与 AgentCorp 既有 `settings` store 隔离
 * （见 docs/architecture-pivot.md §2.D / §3 / §8）。
 *
 * 沿用 electron/utils/store.ts 的 lazy-load 模式（动态 import electron-store），
 * 避免渲染层打包期解析 Node 模块，并确保仅在 Runtime 可用时初始化。
 */

import type { EvaluationProfile } from '@/types/evaluation';

// 浏览器预览（web 预览版）没有 electron-store / 真实文件系统；该标志由
// vite.web.config.ts 注入的 shim 设置。浏览器里惰性加载直接短路返回 null，
// 避免任何路径在预览中触碰 node:fs（前端与后端能力解耦）。
const IS_BROWSER_PREVIEW =
  typeof window !== 'undefined' &&
  (
    window as unknown as {
      electron?: { __agentcorpBrowserPreviewShim?: boolean };
    }
  ).electron?.__agentcorpBrowserPreviewShim === true;

// Lazy-load electron-store（ESM module），与 electron/utils/store.ts 保持一致。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let evaluationStoreInstance: any = null;

/**
 * 获取（惰性初始化）评估档案 store 实例。
 * 浏览器预览环境无 electron-store，返回 null（调用方据此降级为内存/空数据）。
 */
async function getEvaluationStore() {
  if (IS_BROWSER_PREVIEW) return null;
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
  if (!store) return;
  store.set(profile.agentId, profile);
}

/**
 * 按 agentId 读取评估档案。
 * @returns 命中则返回 EvaluationProfile，否则 undefined。
 */
export async function load(agentId: string): Promise<EvaluationProfile | undefined> {
  const store = await getEvaluationStore();
  if (!store) return undefined;
  return store.get(agentId) as EvaluationProfile | undefined;
}

/**
 * 列出全部评估档案。
 * 过滤 electron-store 内部迁移键（`__internal__`），仅返回 EvaluationProfile。
 */
export async function list(): Promise<EvaluationProfile[]> {
  const store = await getEvaluationStore();
  if (!store) return [];
  const all = store.store as Record<string, EvaluationProfile>;
  return Object.values(all).filter(
    (value): value is EvaluationProfile =>
      !!value && typeof value === 'object' && 'agentId' in value,
  );
}
