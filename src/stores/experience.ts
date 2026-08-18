/**
 * src/stores/experience.ts
 * 团队经验卡 store（F：Reflexion 式团队记忆，arXiv:2303.11366；
 * MetaGPT 经验复用，arXiv:2308.00352。见 types/experience.ts）。
 *
 * 数据闭环的渲染层一侧：
 * - 编排前：getExperience 拉该团队经验卡 → buildExperienceText 取最近 10 条
 *   拼成「- 内容」每行一条的文本，注入 OrchestrationInput.experience。
 * - 交付后：reflectExperience 调一次 leader 视角的 chat 复盘一条 ≤150 字
 *   经验教训 → appendExperience 落库（source 记 taskId）。
 *
 * 全链路失败静默：经验卡是增强信号，任何一步失败都不阻塞编排/交付。
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import type { ExperienceCard, TeamExperienceSnapshot } from '@/types/experience';
import type { SubTaskResult } from '@/engine/squad/squadOrchestration';
import type { ChatMessage } from '@/engine/squad/squadCollaboration';

/** 注入编排的经验卡条数上限（最近 N 条）。 */
export const EXPERIENCE_INJECT_LIMIT = 10;

/**
 * 经验卡 → 注入文本纯函数：取最近 limit 条，每行「- 内容」。
 * 无卡返回 undefined（调用侧不把空经验注入编排输入）。
 */
export function buildExperienceText(
  cards: ExperienceCard[],
  limit = EXPERIENCE_INJECT_LIMIT,
): string | undefined {
  if (!cards.length) return undefined;
  const lines = cards.slice(-limit).map((c) => `- ${c.content}`);
  return lines.length ? lines.join('\n') : undefined;
}

/** 子任务执行情况的单行描述（通过/返工/失败），供复盘 prompt 使用。 */
function describeSubTask(s: SubTaskResult): string {
  if (s.error) return `失败（${s.error.slice(0, 50)}）`;
  if (s.approved) return s.rounds > 1 ? `通过（返工 ${s.rounds - 1} 次后过关）` : '一次通过';
  return `未通过（${s.rounds} 轮仍未达标）`;
}

/**
 * leader 视角复盘 prompt 纯函数：任务标题 + 各子任务通过/返工/失败情况，
 * 要求产出一条 ≤150 字、可复用到下次同类任务的经验教训。
 */
export function buildReflectionPrompt(taskTitle: string, subtasks: SubTaskResult[]): string {
  const lines = subtasks.map((s) => `- 「${s.title}」（${s.assigneeId}）：${describeSubTask(s)}`);
  return [
    `团队刚完成任务：「${taskTitle}」。各子任务执行情况：`,
    ...lines,
    '',
    '请以 leader 视角写一条经验教训（≤150 字），供下次同类任务参考。'
      + '聚焦可复用的做法或要避开的坑（分工是否合理、哪类子任务容易返工、协作衔接要点），'
      + '不要复述任务内容本身。只输出经验正文，不要任何前缀或解释。',
  ].join('\n');
}

export interface ReflectExperienceInput {
  teamId: string;
  /** 任务 id（落库为经验卡 source）。 */
  taskId: string;
  taskTitle: string;
  subtasks: SubTaskResult[];
  /** 注入的真实 chat（leader 视角身份由调用方在 ctx/闭包里带）。 */
  chat: (messages: ChatMessage[]) => Promise<string>;
}

/**
 * 交付后复盘并落一条经验卡。全链路 try/catch：LLM 复盘或落库失败都静默，
 * 绝不阻塞交付主链路。返回是否成功落下一条卡（供单测观测）。
 */
export async function reflectExperience(input: ReflectExperienceInput): Promise<boolean> {
  try {
    if (!input.subtasks.length) return false;
    const content = (
      await input.chat([
        {
          role: 'system',
          content: '你是这个团队的 leader，刚带领团队完成上面这条任务，正在做赛后复盘。',
        },
        { role: 'user', content: buildReflectionPrompt(input.taskTitle, input.subtasks) },
      ])
    ).trim();
    if (!content) return false;
    await useExperienceStore.getState().appendExperience(input.teamId, content, input.taskId);
    return true;
  } catch {
    /* 经验复盘失败静默，不阻塞交付 */
    return false;
  }
}

interface ExperienceState {
  /** teamId → 经验卡列表（最近一次拉取/追加的快照）。 */
  cardsByTeam: Record<string, ExperienceCard[]>;

  /** 拉该团队经验卡并进 store；失败静默返回空数组。 */
  getExperience: (teamId: string) => Promise<ExperienceCard[]>;
  /** append 单条（source 记 taskId）并用返回快照同步 store；失败静默。 */
  appendExperience: (teamId: string, content: string, source?: string) => Promise<void>;
}

export const useExperienceStore = create<ExperienceState>((set) => ({
  cardsByTeam: {},

  getExperience: async (teamId) => {
    try {
      const snapshot = await hostApiFetch<TeamExperienceSnapshot>(
        `/api/teams/${encodeURIComponent(teamId)}/experience`,
      );
      const cards = snapshot?.cards ?? [];
      set((s) => ({ cardsByTeam: { ...s.cardsByTeam, [teamId]: cards } }));
      return cards;
    } catch {
      /* 经验卡拉取失败静默：本次编排不带经验注入 */
      return [];
    }
  },

  appendExperience: async (teamId, content, source) => {
    try {
      const snapshot = await hostApiFetch<TeamExperienceSnapshot>(
        `/api/teams/${encodeURIComponent(teamId)}/experience`,
        { method: 'POST', body: JSON.stringify({ content, source }) },
      );
      if (snapshot?.cards) {
        set((s) => ({ cardsByTeam: { ...s.cardsByTeam, [teamId]: snapshot.cards } }));
      }
    } catch {
      /* 经验卡落库失败静默 */
    }
  },
}));
