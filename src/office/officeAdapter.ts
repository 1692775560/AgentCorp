/**
 * src/office/officeAdapter.ts
 * 像素办公室数据适配器：真实 agent/评估 → 像素引擎（OfficeState / Character / 部门区域）。
 *
 * 单一职责：把 AgentCorp 的入职花名册（engine/office/assignment.computeOfficeRoster）
 * 转换为像素引擎需要的形态：
 *   - 字符串 agentId ↔ 稳定 number id（引擎用 number 主键）；
 *   - AgentCorp 部门(dept) → 布局区域标签(area label)：
 *       engineering → 'Engineering'、design → 'Design'、pm → 'PM'；
 *   - folderName → areaMappings（供 OfficeState.addAgent 的 3 段式座位分配落到对应区域）；
 *   - candidatesByArea(area)：按区域返回候选（供 DepartmentOverlay 的实时人数/面板）。
 *
 * 数据真相仍在评估层；本模块不落库、无副作用（纯函数 + 一个稳定 id 分配器）。
 */
import type { OfficeEmployee, OfficeDept } from '@/engine/office/assignment';

/** 引擎侧候选卡（对齐 pixel-agents components/candidates.Candidate 的被消费字段）。 */
export interface PixelCandidate {
  /** 稳定 number id（与引擎 Character.id 一致） */
  numId: number;
  /** 原始字符串 agentId */
  agentId: string;
  name: string;
  /** 区域标签（布局 area label） */
  area: string;
  verdict: 'mvp' | 'watch' | 'fired';
  bio: string;
}

/** AgentCorp 部门 → 布局区域标签（与 assignment 的工种映射一致）。 */
const DEPT_TO_AREA: Record<OfficeDept, string | null> = {
  engineering: 'Engineering',
  design: 'Design',
  pm: 'PM',
  unassigned: null, // 未定工种：不强制归区，引擎按空闲座位安置
};

/** 区域标签 → folderName（引擎用 folderName 索引 areaMappings；此处一一对应）。 */
export function areaToFolder(area: string): string {
  return `dept:${area}`;
}

/**
 * 稳定的字符串→number id 分配器（同一 agentId 多次调用返回同一 number）。
 * 引擎主键是 number，且需跨帧稳定，故用模块级 Map 记忆。
 */
const idMap = new Map<string, number>();
let nextId = 1;
export function toNumId(agentId: string): number {
  let n = idMap.get(agentId);
  if (n === undefined) {
    n = nextId++;
    idMap.set(agentId, n);
  }
  return n;
}

/** 反查：number id → 字符串 agentId（点选像素角色时用）。 */
export function toAgentId(numId: number): string | undefined {
  for (const [aid, n] of idMap) if (n === numId) return aid;
  return undefined;
}

/** 由入职花名册生成引擎候选列表。 */
export function rosterToPixelCandidates(roster: OfficeEmployee[]): PixelCandidate[] {
  return roster.map((e) => ({
    numId: toNumId(e.agentId),
    agentId: e.agentId,
    name: e.name,
    area: DEPT_TO_AREA[e.dept] ?? 'Lobby',
    verdict: e.verdict === 'MVP' ? 'mvp' : e.verdict === 'OBSERVE' ? 'watch' : 'fired',
    bio: e.bio,
  }));
}

/**
 * 生成 OfficeState.setAreaMappings 需要的映射：folderName → [area label]。
 * 每个出现过的部门区域各建一条（folder 'dept:Engineering' → ['Engineering']）。
 */
export function buildAreaMappings(candidates: PixelCandidate[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const c of candidates) {
    const folder = areaToFolder(c.area);
    if (!map[folder]) map[folder] = [c.area];
  }
  return map;
}

/**
 * 当前候选快照（供 candidatesByArea 查询）。由 /office 页面在 roster 变化时调用
 * setPixelCandidates 刷新——DepartmentOverlay 通过 candidatesByArea 读取实时人数。
 */
let currentCandidates: PixelCandidate[] = [];
export function setPixelCandidates(candidates: PixelCandidate[]): void {
  currentCandidates = candidates;
}

/** 按区域返回候选（DepartmentOverlay 计数用；替代 pixel-agents 的 mock candidatesByArea）。 */
export function candidatesByArea(area: string): PixelCandidate[] {
  return currentCandidates.filter((c) => c.area === area);
}
