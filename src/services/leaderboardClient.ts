/**
 * src/services/leaderboardClient.ts
 * 双榜数据拉取（镜像后端 /api/leaderboard）。
 *
 * 网络：经 Host API 代理调用 model-service 的 /api/leaderboard。
 * GET /api/leaderboard?stage=&jobType=&subjective=
 *   - stage：必填（preScreen/interview/performance）
 *   - jobType：工种或 "all"
 *   - subjective（可选）：JSON 数组，agentId 拖拽序；用于派生 divergences
 *
 * 返回 DualLeaderboard（客观榜 + 主观榜 + 复核发散）。
 */
import { hostApiFetch } from '@/lib/host-api';
import type { DualLeaderboard, StageKey, JobType } from '@/types/evaluation';

const BASE = '/api/leaderboard';

export async function getDualLeaderboard(
  stage: StageKey,
  jobType: JobType | 'all' = 'all',
  subjectiveOrder?: string[],
): Promise<DualLeaderboard> {
  const params = new URLSearchParams({ stage, jobType });
  if (subjectiveOrder && subjectiveOrder.length > 0) {
    params.set('subjective', JSON.stringify(subjectiveOrder));
  }
  return hostApiFetch<DualLeaderboard>(`${BASE}?${params.toString()}`, { method: 'GET' });
}

export const leaderboardClient = {
  getDualLeaderboard,
};
