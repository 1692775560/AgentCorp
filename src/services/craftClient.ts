/**
 * src/services/craftClient.ts
 * HR 面试试做题（craft）客户端：题库拉取 + 单题 LLM-as-judge 评分。
 *
 * 网络：经 Host API 代理（hostApiFetch → IPC → 127.0.0.1:3210 → model-service），
 * 与 convergenceService / leaderboardClient 同一条链路，凭据只在主进程。
 *
 * 与 judgeClient.judgeChat 的边界：judgeChat 评「面试对话」，本模块评「工种试做题」。
 * 试做题是客观分的来源 —— 同题同 rubric，个人上传的 agent 与头部开源项目起点一致。
 *
 * 后端 judge 不可用时上游返回 503，hostApiFetch 会抛错。这里**不吞异常也不造分**：
 * 由调用方决定标注「未评测」还是提示配置后端，避免把降级分当真实评测展示。
 */
import { hostApiFetch } from '@/lib/host-api';
import type { CraftJudgeInput, CraftJudgement, CraftTask } from '@/types/craft';

/** 拉取公开题库（不含参考答案）。 */
export async function fetchCraftTasks(): Promise<CraftTask[]> {
  const res = await hostApiFetch<CraftTask[]>('/api/craft-tasks', { method: 'GET' });
  return Array.isArray(res) ? res : [];
}

/** 按工种筛题。job_type 与 JobType 同键（image / text / code）。 */
export function tasksForJob(tasks: CraftTask[], jobType: string): CraftTask[] {
  return tasks.filter((t) => t.job_type === jobType);
}

/**
 * 对一道试做题评分。judge 后端不可用时抛错（上游 503），不返回伪造分数。
 */
export async function judgeCraftTask(input: CraftJudgeInput): Promise<CraftJudgement> {
  return hostApiFetch<CraftJudgement>('/api/craft-judge', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export const craftClient = { fetchCraftTasks, tasksForJob, judgeCraftTask };
