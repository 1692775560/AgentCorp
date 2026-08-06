/**
 * src/services/preferenceStore.ts
 * 偏好信号落库（T8，镜像后端 PreferenceProfile 回灌）。
 *
 * 本地落库：electron-store 命名空间 `agentcorp.preference`
 *   （<userData>/agentcorp.preference.json）。
 *   - signals.<ownerId>：PreferenceSignal[]（累计拖拽信号）
 *   - profile.<ownerId>：最近一次聚合的 PreferenceProfile
 *
 * 沿用其它 store 的惰性 electron-store 模式（动态 import electron-store）。
 */
import type { PreferenceSignal, PreferenceProfile } from '@/types/evaluation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prefStoreInstance: any = null;

async function getPrefStore() {
  if (!prefStoreInstance) {
    const Store = (await import('electron-store')).default;
    prefStoreInstance = new Store({ name: 'agentcorp.preference' });
  }
  return prefStoreInstance;
}

/** 追加一条偏好信号（按 ownerId 累计）。 */
export async function appendSignal(ownerId: string, signal: PreferenceSignal): Promise<void> {
  try {
    const store = await getPrefStore();
    const key = `signals.${ownerId}`;
    const arr: PreferenceSignal[] = (store.get(key) as PreferenceSignal[]) ?? [];
    arr.push(signal);
    store.set(key, arr);
  } catch {
    // 缓存失败不影响主流程
  }
}

/** 读取某 owner 的累计信号。 */
export async function loadSignals(ownerId: string): Promise<PreferenceSignal[]> {
  try {
    const store = await getPrefStore();
    return (store.get(`signals.${ownerId}`) as PreferenceSignal[]) ?? [];
  } catch {
    return [];
  }
}

/** 保存最近一次聚合画像。 */
export async function saveProfile(ownerId: string, profile: PreferenceProfile): Promise<void> {
  try {
    const store = await getPrefStore();
    store.set(`profile.${ownerId}`, profile);
  } catch {
    // 忽略
  }
}

/** 读取最近一次聚合画像。 */
export async function loadProfile(ownerId: string): Promise<PreferenceProfile | undefined> {
  try {
    const store = await getPrefStore();
    return store.get(`profile.${ownerId}`) as PreferenceProfile | undefined;
  } catch {
    return undefined;
  }
}

/** 清空某 owner 的偏好信号与画像。 */
export async function clear(ownerId: string): Promise<void> {
  try {
    const store = await getPrefStore();
    store.delete(`signals.${ownerId}`);
    store.delete(`profile.${ownerId}`);
  } catch {
    // 忽略
  }
}

export const preferenceStore = {
  appendSignal,
  loadSignals,
  saveProfile,
  loadProfile,
  clear,
};
