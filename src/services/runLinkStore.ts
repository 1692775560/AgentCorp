/**
 * src/services/runLinkStore.ts
 * 执行主键关联本地落库（electron-store）。
 *
 * 命名空间：`agentcorp.runlinks`（默认落盘 <userData>/agentcorp.runlinks.json）。
 * 键 = runId，值 = RunTaskLink（runId ↔ taskId ↔ agentId ↔ session）。
 * 与评估档案 store、ClawCorp 既有 `settings` store 三向隔离
 * （见 docs/architecture-pivot.md §2.D / §3 / §8）。
 *
 * 沿用 electron/utils/store.ts 的 lazy-load 模式（动态 import electron-store）。
 */

import type { RunTaskLink } from '@/types/evaluation';

// Lazy-load electron-store（ESM module），与 electron/utils/store.ts 保持一致。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runLinkStoreInstance: any = null;

/**
 * 获取（惰性初始化）runId↔task 关联 store 实例。
 */
async function getRunLinkStore() {
  if (!runLinkStoreInstance) {
    const Store = (await import('electron-store')).default;
    runLinkStoreInstance = new Store<RunTaskLink>({
      name: 'agentcorp.runlinks',
    });
  }
  return runLinkStoreInstance;
}

/**
 * 保存（覆盖写）一条 runId ↔ task 关联。
 * @param link 关联记录（以 link.runId 为键）
 */
export async function save(link: RunTaskLink): Promise<void> {
  const store = await getRunLinkStore();
  store.set(link.runId, link);
}

/**
 * 按 runId 读取关联记录。
 * @returns 命中则返回 RunTaskLink，否则 undefined。
 */
export async function getByRunId(runId: string): Promise<RunTaskLink | undefined> {
  const store = await getRunLinkStore();
  return store.get(runId) as RunTaskLink | undefined;
}
