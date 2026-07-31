/**
 * src/services/runLinkStore.ts
 * 执行主键关联本地落库（Host API 客户端）。
 *
 * 命名空间：`agentcorp.runlinks`（落盘 <userData>/agentcorp.runlinks.json）。
 * 键 = runId，值 = RunTaskLink（runId ↔ taskId ↔ agentId ↔ session）。
 * 与评估档案 store、AgentCorp 既有 `settings` store 三向隔离
 * （见 docs/architecture-pivot.md §2.D / §3 / §8）。
 *
 * 注：electron-store 只能在主进程使用，实际读写由
 * electron/services/evaluation/eval-store.ts 完成，本模块为薄客户端。
 */

import { hostApiFetch } from '@/lib/host-api';
import type { RunTaskLink } from '@/types/evaluation';

interface HostResponse {
  success: boolean;
  error?: string;
}

/**
 * 保存（覆盖写）一条 runId ↔ task 关联。
 * @param link 关联记录（以 link.runId 为键）
 */
export async function save(link: RunTaskLink): Promise<void> {
  const res = await hostApiFetch<HostResponse>('/api/eval/runlinks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(link),
  });
  if (!res.success) throw new Error(res.error ?? 'runLinkStore.save failed');
}

/**
 * 按 runId 读取关联记录。
 * @returns 命中则返回 RunTaskLink，否则 undefined。
 */
export async function getByRunId(runId: string): Promise<RunTaskLink | undefined> {
  const res = await hostApiFetch<HostResponse & { link?: RunTaskLink | null }>(
    `/api/eval/runlinks/${encodeURIComponent(runId)}`,
  );
  if (!res.success) throw new Error(res.error ?? 'runLinkStore.getByRunId failed');
  return res.link ?? undefined;
}

/**
 * 便捷写入：填充 evaluatedAt 并落库一条 runId ↔ task 关联。
 * @param runId 执行主键（来自 gateway.rpc('chat.send') 返回值）
 * @param link 除 runId / evaluatedAt 外的关联字段
 * @returns 落库后的完整 RunTaskLink
 */
export async function saveForRun(
  runId: string,
  link: Omit<RunTaskLink, 'runId' | 'evaluatedAt'>,
): Promise<RunTaskLink> {
  const res = await hostApiFetch<HostResponse & { link?: RunTaskLink }>('/api/eval/runlinks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, ...link }),
  });
  if (!res.success || !res.link) throw new Error(res.error ?? 'runLinkStore.saveForRun failed');
  return res.link;
}
