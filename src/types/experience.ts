/**
 * 团队经验卡类型（F：Reflexion 式团队记忆）。
 *
 * 理论依据：
 * - Reflexion（arXiv:2303.11366）：任务结束后用语言化「经验教训」替代参数更新，
 *   写入情景记忆，下次同类任务时取回注入提示词，避免重复犯错。
 * - MetaGPT（arXiv:2308.00352）经验复用段落：把历史执行中沉淀的经验作为
 *   可检索资产复用到后续任务，提升多 agent 协作的一致性。
 *
 * 落地：每条任务交付后由 leader 视角复盘一条 ≤150 字经验卡（本类型），
 * 持久化到 team-experience.json（每团队封顶 20 条，裁最旧）；下次编排前取
 * 最近 10 条拼成「- 内容」文本注入 OrchestrationInput.experience。
 */

/** 一条团队经验卡。 */
export interface ExperienceCard {
  id: string;
  /** 经验教训正文（leader 复盘产出，约定 ≤150 字）。 */
  content: string;
  /** 来源标识（记录产生该经验的 taskId）。 */
  source: string;
  createdAt: string;
}

/** GET/POST /api/teams/:id/experience 的响应快照。 */
export interface TeamExperienceSnapshot {
  cards: ExperienceCard[];
}
