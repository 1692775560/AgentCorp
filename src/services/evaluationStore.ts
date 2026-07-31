/**
 * src/services/evaluationStore.ts
 * 评估档案本地落库（Host API 客户端）。
 *
 * 命名空间：`agentcorp.evaluation`（落盘 <userData>/agentcorp.evaluation.json）。
 * 键 = agentId，值 = EvaluationProfile。与 AgentCorp 既有 `settings` store 隔离
 * （见 docs/architecture-pivot.md §2.D / §3 / §8）。
 *
 * 注：electron-store 只能在主进程使用（渲染进程 nodeIntegration=false），
 * 实际读写由 electron/services/evaluation/eval-store.ts 完成，本模块为薄客户端。
 */

import { hostApiFetch } from '@/lib/host-api';
import type { EvaluationProfile } from '@/types/evaluation';

interface HostResponse {
  success: boolean;
  error?: string;
}

/**
 * 保存（覆盖写）某个 agent 的评估档案。
 * @param profile 评估档案（以 profile.agentId 为键）
 */
export async function save(profile: EvaluationProfile): Promise<void> {
  const res = await hostApiFetch<HostResponse>('/api/eval/profiles', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  if (!res.success) throw new Error(res.error ?? 'evaluationStore.save failed');
}

/**
 * 按 agentId 读取评估档案。
 * @returns 命中则返回 EvaluationProfile，否则 undefined。
 */
export async function load(agentId: string): Promise<EvaluationProfile | undefined> {
  const res = await hostApiFetch<HostResponse & { profile?: EvaluationProfile | null }>(
    `/api/eval/profiles/${encodeURIComponent(agentId)}`,
  );
  if (!res.success) throw new Error(res.error ?? 'evaluationStore.load failed');
  return res.profile ?? undefined;
}

/**
 * 列出全部评估档案。
 */
export async function list(): Promise<EvaluationProfile[]> {
  const res = await hostApiFetch<HostResponse & { profiles?: EvaluationProfile[] }>(
    '/api/eval/profiles',
  );
  if (!res.success) throw new Error(res.error ?? 'evaluationStore.list failed');
  return res.profiles ?? [];
}
