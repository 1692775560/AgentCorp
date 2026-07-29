/**
 * src/services/scoringRulesService.ts
 * 规则预设拉取/保存（T5，镜像后端 /api/rules）。
 *
 * 网络：经 Host API 代理调用 model-service 的 /api/rules（GET/PUT）。
 * 本地缓存：electron-store 命名空间 `agentcorp.scoring-rules`
 *   （<userData>/agentcorp.scoring-rules.json），存入最近一次读取/保存的规则，
 *   离线时可直接回退缓存。
 *
 * 沿用 convergenceService 的惰性 electron-store 模式（动态 import electron-store），
 * 避免渲染层打包期解析 Node 模块。
 */
import { hostApiFetch } from '@/lib/host-api';
import type { ScoringRules } from '@/engine/scoring/rulesEngine';

const BASE = '/api/rules';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rulesStoreInstance: any = null;

async function getRulesStore() {
  if (!rulesStoreInstance) {
    const Store = (await import('electron-store')).default;
    rulesStoreInstance = new Store({ name: 'agentcorp.scoring-rules' });
  }
  return rulesStoreInstance;
}

/** GET /api/rules?preset= —— 读取规则预设（default / cost-focused / quality-focused）。 */
export async function loadRules(preset: string = 'default'): Promise<ScoringRules> {
  const data = await hostApiFetch<ScoringRules>(`${BASE}?preset=${encodeURIComponent(preset)}`, {
    method: 'GET',
  });
  // 缓存到本地
  try {
    const store = await getRulesStore();
    store.set(`rules.${preset}`, data);
  } catch {
    // 缓存失败不影响主流程
  }
  return data;
}

/** PUT /api/rules —— 保存规则预设（落库到 presets/<presetId>.json + 内存）。 */
export async function saveRules(presetId: string, rules: ScoringRules): Promise<{ ok: boolean; presetId: string }> {
  const res = await hostApiFetch<{ ok: boolean; presetId: string }>(BASE, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presetId, rules }),
  });
  try {
    const store = await getRulesStore();
    store.set(`rules.${presetId}`, rules);
  } catch {
    // 缓存失败不影响主流程
  }
  return res;
}

/** 读取本地缓存的规则（离线回退，可能为空）。 */
export async function readCachedRules(preset: string): Promise<ScoringRules | undefined> {
  try {
    const store = await getRulesStore();
    return store.get(`rules.${preset}`) as ScoringRules | undefined;
  } catch {
    return undefined;
  }
}

export const scoringRulesService = {
  loadRules,
  saveRules,
  readCachedRules,
};
