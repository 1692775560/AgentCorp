/**
 * electron/services/evaluation/eval-store.ts
 * 评估档案 / runlink 主进程落库（electron-store）。
 *
 * 从渲染层迁入（原 src/services/evaluationStore.ts / runLinkStore.ts）：
 * 渲染进程 nodeIntegration=false，electron-store 只能在主进程使用。
 * 命名空间与键值语义保持不变，<userData> 下既有数据文件无缝衔接：
 * - `agentcorp.evaluation`：键 = agentId，值 = EvaluationProfile
 * - `agentcorp.runlinks`：键 = runId，值 = RunTaskLink
 */

import type { EvaluationProfile, RunTaskLink } from '../../../src/types/evaluation';

// Lazy-load electron-store（ESM module），与 electron/utils/store.ts 保持一致。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let evaluationStoreInstance: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runLinkStoreInstance: any = null;

async function getEvaluationStore() {
  if (!evaluationStoreInstance) {
    const Store = (await import('electron-store')).default;
    evaluationStoreInstance = new Store({ name: 'agentcorp.evaluation' });
  }
  return evaluationStoreInstance;
}

async function getRunLinkStore() {
  if (!runLinkStoreInstance) {
    const Store = (await import('electron-store')).default;
    runLinkStoreInstance = new Store({ name: 'agentcorp.runlinks' });
  }
  return runLinkStoreInstance;
}

/** 保存（覆盖写）某个 agent 的评估档案 */
export async function saveProfile(profile: EvaluationProfile): Promise<void> {
  const store = await getEvaluationStore();
  store.set(profile.agentId, profile);
}

/** 按 agentId 读取评估档案 */
export async function loadProfile(agentId: string): Promise<EvaluationProfile | undefined> {
  const store = await getEvaluationStore();
  return store.get(agentId) as EvaluationProfile | undefined;
}

/** 列出全部评估档案（过滤 electron-store 内部迁移键） */
export async function listProfiles(): Promise<EvaluationProfile[]> {
  const store = await getEvaluationStore();
  const all = store.store as Record<string, EvaluationProfile>;
  return Object.values(all).filter(
    (value): value is EvaluationProfile =>
      !!value && typeof value === 'object' && 'agentId' in value,
  );
}

/** 保存（覆盖写）一条 runId ↔ task 关联 */
export async function saveRunLink(link: RunTaskLink): Promise<void> {
  const store = await getRunLinkStore();
  store.set(link.runId, link);
}

/** 按 runId 读取关联记录 */
export async function getRunLink(runId: string): Promise<RunTaskLink | undefined> {
  const store = await getRunLinkStore();
  return store.get(runId) as RunTaskLink | undefined;
}
