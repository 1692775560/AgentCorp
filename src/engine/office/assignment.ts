/**
 * src/engine/office/assignment.ts
 * Agent Office 入职分配引擎（纯函数，单一真相源）。
 *
 * 职责：把 AgentCorp 评估层「层层筛选后胜出的 agent」映射为可在
 * Office 办公室上岗的员工，并按工种自动分配到部门。数据全部来自真实的
 * EvaluationProfile（六维/ROI/生命周期/工种）+ AgentSummary（姓名/头像/画像），
 * 不引入任何 mock —— 没有评估数据时返回空，由页面呈现空态引导去评估。
 *
 * 规则（owner 决策）：
 * - 工种 → 部门：code → 工程部(Engineering)、image → 产品设计(Design)、
 *   text → 产品规划(PM)；未知/缺失工种归入「待分配」。
 * - 准入：仅 verdict = MVP / OBSERVE 入职上岗；FIRED（lifecycle=RETIRED）不进。
 */
import type { AgentSummary } from '@/types/agent';
import type {
  EvaluationProfile,
  JobType,
  RadarScore,
  Verdict,
} from '@/types/evaluation';

/** Office 部门标识（与 UI 分组一致）。 */
export type OfficeDept = 'engineering' | 'design' | 'pm' | 'unassigned';

/** 部门展示元信息。 */
export const OFFICE_DEPTS: Record<
  OfficeDept,
  { label: string; en: string; accent: string; glyph: string; desc: string }
> = {
  engineering: { label: '工程部', en: 'Engineering', accent: '#3b82f6', glyph: '⚙', desc: '构建与交付核心产品 · 承接 code 工种' },
  design:      { label: '产品设计', en: 'Design',      accent: '#a855f7', glyph: '✎', desc: '体验、视觉与设计系统 · 承接 image 工种' },
  pm:          { label: '产品规划', en: 'Product',     accent: '#f97316', glyph: '◎', desc: '方向、优先级与路线图 · 承接 text 工种' },
  unassigned:  { label: '待分配',   en: 'Unassigned',  accent: '#9ca3af', glyph: '○', desc: '工种未定，等待 HR 归岗' },
};

/** 部门展示顺序。 */
export const OFFICE_DEPT_ORDER: OfficeDept[] = ['engineering', 'design', 'pm', 'unassigned'];

/** 工种 → 部门映射（owner 决策）。 */
export function jobTypeToDept(jobType: JobType | undefined): OfficeDept {
  switch (jobType) {
    case 'code':  return 'engineering';
    case 'image': return 'design';
    case 'text':  return 'pm';
    default:      return 'unassigned';
  }
}

/** verdict 中文/状态色。 */
export const VERDICT_META: Record<Verdict, { label: string; color: string; glyph: string }> = {
  MVP:    { label: 'MVP',    color: '#22c55e', glyph: '★' },
  OBSERVE:{ label: '待观察', color: '#fbbf24', glyph: '◐' },
  FIRED:  { label: '淘汰',   color: '#ef4444', glyph: '✕' },
};

/** 一名已入职上岗的员工（分配结果条目）。 */
export interface OfficeEmployee {
  agentId: string;
  name: string;
  avatar?: string | null;
  /** 一句话简介（取自 agent 画像 / 职责） */
  bio: string;
  dept: OfficeDept;
  jobType: JobType | undefined;
  verdict: Verdict;
  /** 六维雷达（0–5，来自评估） */
  radar: RadarScore;
  /** 用户契合度 0–100（由 ROI / cps 归一，缺失则用六维均值×20 兜底） */
  userFit: number;
  /** 是否为 MVP（用于高亮） */
  isMvp: boolean;
}

/**
 * 从一个 EvaluationProfile 推断 verdict。
 * - lifecycle=RETIRED → FIRED（淘汰，不入职）。
 * - 否则取 stageScores 最后一条的 verdict；缺失时按 user_fit / 六维均值推断
 *   （高分 → MVP，其余 → OBSERVE）。
 */
export function inferVerdict(profile: EvaluationProfile): Verdict {
  if (profile.lifecycle === 'RETIRED') return 'FIRED';
  const stages = profile.stageScores ?? [];
  const last = stages.length > 0 ? stages[stages.length - 1] : undefined;
  if (last?.verdict) return last.verdict;
  const avg = radarAvg(profile.radarLatest);
  return avg >= 4 ? 'MVP' : 'OBSERVE';
}

/** 六维均值（0–5）。 */
function radarAvg(r: RadarScore): number {
  const vals = [r.task, r.quality, r.comm, r.creativity, r.reliability, r.cost];
  const sum = vals.reduce((a, b) => a + b, 0);
  return vals.length ? sum / vals.length : 0;
}

/** 由 ROI cps（0–5）或六维均值推导 user_fit（0–100）。 */
function deriveUserFit(profile: EvaluationProfile): number {
  const cps = profile.roiLatest?.cost_perf_score;
  if (typeof cps === 'number' && cps > 0) return Math.round(Math.min(5, cps) * 20);
  return Math.round(radarAvg(profile.radarLatest) * 20);
}

/**
 * 计算 Office 入职花名册：遍历评估档案，取胜出（非 FIRED）者，按工种归岗。
 * @param profiles 评估档案表（agentId → EvaluationProfile）
 * @param agents   agent 概要列表（补充姓名 / 头像 / 画像）
 */
export function computeOfficeRoster(
  profiles: Record<string, EvaluationProfile>,
  agents: AgentSummary[],
): OfficeEmployee[] {
  const nameById = new Map(agents.map((a) => [a.id, a]));
  const out: OfficeEmployee[] = [];

  for (const profile of Object.values(profiles)) {
    const verdict = inferVerdict(profile);
    if (verdict === 'FIRED') continue; // 淘汰的不入职

    const agent = nameById.get(profile.agentId);
    const bio =
      agent?.responsibility?.trim() ||
      agent?.persona?.trim()?.slice(0, 40) ||
      '已通过 HR 评估，等待任务派发';

    out.push({
      agentId: profile.agentId,
      name: agent?.name ?? profile.agentId,
      avatar: agent?.avatar ?? null,
      bio,
      dept: jobTypeToDept(profile.jobType),
      jobType: profile.jobType,
      verdict,
      radar: profile.radarLatest,
      userFit: deriveUserFit(profile),
      isMvp: verdict === 'MVP',
    });
  }

  // MVP 优先、其次按 user_fit 降序（与评估台的实时重排一致）
  out.sort((a, b) => {
    if (a.isMvp !== b.isMvp) return a.isMvp ? -1 : 1;
    return b.userFit - a.userFit;
  });
  return out;
}

/** 按部门分组（保持 OFFICE_DEPT_ORDER 顺序，空部门也保留以呈现完整办公室）。 */
export function groupByDept(
  roster: OfficeEmployee[],
): Array<{ dept: OfficeDept; members: OfficeEmployee[] }> {
  return OFFICE_DEPT_ORDER.map((dept) => ({
    dept,
    members: roster.filter((e) => e.dept === dept),
  }));
}
