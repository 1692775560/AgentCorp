/**
 * src/services/interviewStore.ts
 * 面试报告本地落库（electron-store，模块 B · 设计 §4.1）。
 *
 * 命名空间：`agentcorp.interview`（默认落盘 <userData>/agentcorp.interview.json）。
 * 键 = interviewId，值 = InterviewReport。
 *
 * ★ 数据流通道②（面试记录 → 绩效基线）的存储端：
 *   面试结束 → save(report) → 绩效侧 `stores/evaluation.runEvaluation`
 *   调 latestByAgent(agentId) 读取最新报告 → 写入 EvaluationProfile.interviewBaseline。
 *
 * 沿用 services/evaluationStore.ts 的 lazy-load 模式（动态 import electron-store），
 * 避免渲染层打包期解析 Node 模块。
 */
import type { InterviewReport } from '@/types/interview';
import type { UserQuestionRound } from '@/types/interview';

// Lazy-load electron-store（ESM module），与 evaluationStore.ts 保持一致。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let interviewStoreInstance: any = null;

/** 获取（惰性初始化）面试报告 store 实例。 */
async function getInterviewStore() {
  if (!interviewStoreInstance) {
    const Store = (await import('electron-store')).default;
    interviewStoreInstance = new Store<InterviewReport>({
      name: 'agentcorp.interview',
    });
  }
  return interviewStoreInstance;
}

/** 保存（覆盖写）一份面试报告（以 report.interviewId 为键）。 */
export async function save(report: InterviewReport): Promise<void> {
  const store = await getInterviewStore();
  store.set(report.interviewId, report);
}

/** 按 interviewId 读取面试报告。 */
export async function load(interviewId: string): Promise<InterviewReport | undefined> {
  const store = await getInterviewStore();
  return store.get(interviewId) as InterviewReport | undefined;
}

/** 列出全部面试报告（过滤 electron-store 内部键）。 */
export async function list(): Promise<InterviewReport[]> {
  const store = await getInterviewStore();
  const all = store.store as Record<string, InterviewReport>;
  return Object.values(all).filter(
    (value): value is InterviewReport =>
      !!value && typeof value === 'object' && 'interviewId' in value && 'agentId' in value,
  );
}

/** 某 agent 的全部面试报告（按 ts 降序，最新在前）。 */
export async function listByAgent(agentId: string): Promise<InterviewReport[]> {
  const all = await list();
  return all
    .filter((report) => report.agentId === agentId)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

/** 某 agent 的最新一份面试报告（通道② 读取点）；无则 null。 */
export async function latestByAgent(agentId: string): Promise<InterviewReport | null> {
  const reports = await listByAgent(agentId);
  return reports[0] ?? null;
}

/**
 * 追加/更新用户自定义题小节（设计 §3 / T04）。
 * 仅加法：加载既有报告 → 合并 userQuestionRound → 覆盖写。
 * 不进 turns[]、不进 dimTracker 证据、不进模型分（报告结构不变，仅多一个可选字段）。
 */
export async function saveUserQuestionRound(
  interviewId: string,
  round: UserQuestionRound,
): Promise<void> {
  const store = await getInterviewStore();
  const existing = store.get(interviewId) as InterviewReport | undefined;
  const report: InterviewReport = {
    ...(existing ?? ({} as InterviewReport)),
    userQuestionRound: round,
  };
  store.set(interviewId, report);
}

export const interviewStore = { save, load, list, listByAgent, latestByAgent, saveUserQuestionRound };
