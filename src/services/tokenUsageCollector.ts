/**
 * src/services/tokenUsageCollector.ts
 * 真实 token 用量采集（T05）。
 *
 * 复用 AgentCorp 既有能力 getRecentTokenUsageHistory（@electron/utils/token-usage），
 * 按 agentId / sessionId 过滤得到 TokenUsageHistoryEntry[]，供真实 ROI 计算使用。
 *
 * 注意：该采集依赖主进程文件系统能力（getRecentTokenUsageHistory 读取
 * ~/.openclaw 转录），与 T03 evaluationStore 的 electron-store 同属主进程服务。
 *
 * ⚠️ 浏览器预览（web 预览版）没有真实文件系统，且 @electron/utils/token-usage
 * 顶层静态 import 了 node:fs。因此本模块不再静态 import 该函数，改为运行时「动态
 * import」并在「浏览器守卫」下短路返回空数组，避免 "Dynamic require of fs/promises"。
 */
import type { TokenUsageHistoryEntry } from '@electron/utils/token-usage-core';
import {
  computeRoi,
  DEFAULT_ROI_BASELINE,
  type CostInput,
  type ValueInput,
} from '@/engine/roiEngine';
import type { RoiSnapshot, TelemetryEvent } from '@/types/evaluation';

const IS_BROWSER_PREVIEW =
  typeof window !== 'undefined' &&
  (
    window as unknown as {
      electron?: { __agentcorpBrowserPreviewShim?: boolean };
    }
  ).electron?.__agentcorpBrowserPreviewShim === true;

/** 惰性获取真实 token 用量历史（仅 Electron 运行时可用，浏览器预览安全降级） */
async function getTokenUsageHistory(limit: number): Promise<TokenUsageHistoryEntry[]> {
  if (IS_BROWSER_PREVIEW) return [];
  const { getRecentTokenUsageHistory } = await import('@electron/utils/token-usage');
  return getRecentTokenUsageHistory(limit);
}

/** 当 usage 无 costUsd 时的兜底单价（美元 / 1k token） */
const NOMINAL_COST_PER_1K_TOKENS = 0.01;

/** 单 agent 的全部近期 token 用量 */
export async function collectByAgent(agentId: string): Promise<TokenUsageHistoryEntry[]> {
  const all = await getTokenUsageHistory(2000);
  return all.filter((e) => e.agentId === agentId);
}

/** 单 session 的全部近期 token 用量 */
export async function collectBySession(sessionId: string): Promise<TokenUsageHistoryEntry[]> {
  const all = await getTokenUsageHistory(2000);
  return all.filter((e) => e.sessionId === sessionId);
}

/**
 * 由真实 token 用量 + 遥测聚合出 RoiSnapshot。
 * 成本主线采用 usage 中的 costUsd（缺失时按 token 数兜底折算），
 * 价值主线由客观 KPI（任务完成率）× 单位效用基准推得。
 */
export function buildRoiSnapshot(
  entries: TokenUsageHistoryEntry[],
  telemetry: TelemetryEvent[],
  agentId: string,
  window: string,
  opts?: { radarCost?: number; population?: number[] },
): RoiSnapshot {
  const totalCost = entries.reduce(
    (sum, e) => sum + (e.costUsd ?? (e.totalTokens / 1000) * NOMINAL_COST_PER_1K_TOKENS),
    0,
  );
  const nSuccess = telemetry.filter((t) => t.success).length;
  const tcr = telemetry.length > 0 ? nSuccess / telemetry.length : 0;
  const rework = telemetry.reduce((sum, t) => sum + t.rework, 0);

  const cost: CostInput = {
    c_tok: totalCost,
    c_npu: 0,
    c_call: entries.length * 0.001,
    c_hum: 0,
    c_ret: rework * 0.001,
  };
  const value: ValueInput = {
    weight: { task: 1 },
    success: { task: tcr },
    U_base: 100,
    rho: 1,
    n_retry: rework,
    n_success: nSuccess,
    V_hum: 0,
  };

  const partial = computeRoi(cost, value, DEFAULT_ROI_BASELINE, {
    radarCost: opts?.radarCost,
    population: opts?.population,
  });

  return { agentId, window, ...partial };
}

/** 聚合导出（供 evaluation store 按约定名编排） */
export const tokenUsageCollector = {
  collectByAgent,
  collectBySession,
  buildRoiSnapshot,
};
