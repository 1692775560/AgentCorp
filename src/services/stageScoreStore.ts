/**
 * src/services/stageScoreStore.ts
 * 三阶段评分卡（S1/S2/S3）本地落库（electron-store，模块 B · 设计 §4.1）。
 *
 * 命名空间：`agentcorp.stage-scores`。
 * 键 = `${agentId}:${stage}`（同 agent 同阶段覆盖写，保留最新一张）。
 *
 * 补的是既有缺口：`stores/scoringStore.runStage` 之前只写内存镜像，
 * 刷新即丢，导致市场页的绩效回流（perfBoost）读不到 S3 评分卡。
 *
 * ★ 数据流通道③（绩效结果 → 市场匹配权重）的存储端：
 *   runStage('performance') → save(stageScore)
 *   → 同步回写 EvaluationProfile.stageScores（见 scoringStore）
 *   → 市场 `engine/marketplace/radarSource.latestStageScore('performance')`
 *   → `matchScore.perfBoost` → 候选重排。
 *
 * 沿用 services/evaluationStore.ts 的 lazy-load 模式。
 */
import type { StageKey, StageScore } from '@/types/evaluation';

// Lazy-load electron-store（ESM module）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stageScoreStoreInstance: any = null;

/** 获取（惰性初始化）阶段评分卡 store 实例。 */
async function getStageScoreStore() {
  if (!stageScoreStoreInstance) {
    const Store = (await import('electron-store')).default;
    stageScoreStoreInstance = new Store<StageScore>({
      name: 'agentcorp.stage-scores',
    });
  }
  return stageScoreStoreInstance;
}

/** 组合存储键（agentId 可能含冒号，故 stage 放尾部）。 */
export function stageKey(agentId: string, stage: StageKey): string {
  return `${agentId}:${stage}`;
}

/** 保存（覆盖写）一张阶段评分卡。 */
export async function save(score: StageScore): Promise<void> {
  const store = await getStageScoreStore();
  store.set(stageKey(score.agentId, score.stage), score);
}

/** 读取某 agent 某阶段的最新评分卡。 */
export async function load(agentId: string, stage: StageKey): Promise<StageScore | undefined> {
  const store = await getStageScoreStore();
  return store.get(stageKey(agentId, stage)) as StageScore | undefined;
}

/** 列出全部评分卡（过滤 electron-store 内部键）。 */
export async function list(): Promise<StageScore[]> {
  const store = await getStageScoreStore();
  const all = store.store as Record<string, StageScore>;
  return Object.values(all).filter(
    (value): value is StageScore =>
      !!value && typeof value === 'object' && 'agentId' in value && 'stage' in value,
  );
}

/** 某 agent 的全部阶段评分卡（S1/S2/S3 混合）。 */
export async function listByAgent(agentId: string): Promise<StageScore[]> {
  const all = await list();
  return all.filter((score) => score.agentId === agentId);
}

export const stageScoreStore = { save, load, list, listByAgent, stageKey };
