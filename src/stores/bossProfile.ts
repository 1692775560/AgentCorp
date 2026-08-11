/**
 * src/stores/bossProfile.ts
 * 老板原型（用户个性化画像）store（A · 人格化评估）。
 *
 * 职责：
 * - 持有可选原型表 `profiles`（中性基线 neutral + 预设 + 用户自定义保存的）；
 * - 持有当前激活 `activeId`（默认 neutral，即无个性化离线基线）；
 * - 持有自定义草稿 `draft`（供 BossProfileSelector 表单编辑，save 后落入 profiles）；
 * - 暴露同步读取 `getActiveBossProfile()`，供 interview/evaluation store 在 action 内
 *   把 active 原型喂给 selectQuestions / judgeChatEnsemble（Wang 的「与谁协作」输入）。
 *
 * 设计要点：
 * - neutral 不可删、不可被自定义覆盖（所有 personalization delta 的对照锚点）；
 * - 纯前端内存态，不落库（持久化见 PRD P2）；预设为种子数据，可后续扩 domain。
 * - 与 AgentCorp 既有 agent.persona（agent 自己的系统人设）区分：本 store 描述的是
 *   「正在评估/雇佣这位 agent 的人」。
 */
import { create } from 'zustand';
import type { BossProfile } from '@/types/evaluation';
import { NEUTRAL_BOSS } from '@/types/evaluation';

/** 预设原型（种子数据；后续可扩展 domain / 细分行业）。 */
export const BOSS_PRESETS: BossProfile[] = [
  {
    id: 'boss-growth',
    name: '成长型老板',
    domain: '业务增长',
    experienceLevel: 'intermediate',
    riskAversion: 'low',
    communicationStyle: 'concise',
    constraintPrefs: ['speed', 'cost'],
  },
  {
    id: 'boss-risk',
    name: '风险厌恶老板',
    domain: '合规/金融',
    experienceLevel: 'expert',
    riskAversion: 'high',
    communicationStyle: 'detailed',
    constraintPrefs: ['safety', 'quality'],
  },
  {
    id: 'boss-expert',
    name: '专家老板',
    domain: '技术研究',
    experienceLevel: 'expert',
    riskAversion: 'medium',
    communicationStyle: 'socratic',
    constraintPrefs: ['quality'],
  },
  {
    id: 'boss-novice',
    name: '新手老板',
    domain: '个人副业',
    experienceLevel: 'novice',
    riskAversion: 'medium',
    communicationStyle: 'detailed',
    constraintPrefs: [],
  },
];

/** 自定义草稿的初始模板（每次重置生成新 id，避免覆盖已保存项） */
function freshDraft(): BossProfile {
  return { id: `boss-custom-${Date.now()}`, name: '自定义老板' };
}

interface BossProfileState {
  /** 原型表：键 = BossProfile.id（neutral + 预设 + 自定义） */
  profiles: Record<string, BossProfile>;
  /** 当前激活原型 id（默认 neutral） */
  activeId: string;
  /** 自定义表单草稿 */
  draft: BossProfile;
  /** 切换激活原型 */
  setActive: (id: string) => void;
  /** 保存自定义原型（落入 profiles 并设为激活） */
  saveProfile: (p: BossProfile) => void;
  /** 删除自定义原型（neutral 与预设不可删） */
  removeProfile: (id: string) => void;
  /** 编辑草稿（局部合并） */
  setDraft: (partial: Partial<BossProfile>) => void;
  /** 重置草稿为模板 */
  resetDraft: () => void;
}

/** 初始化原型表：neutral + 全部预设。 */
function seedProfiles(): Record<string, BossProfile> {
  const map: Record<string, BossProfile> = { [NEUTRAL_BOSS.id]: NEUTRAL_BOSS };
  for (const p of BOSS_PRESETS) map[p.id] = p;
  return map;
}

export const useBossProfileStore = create<BossProfileState>((set) => ({
  profiles: seedProfiles(),
  activeId: NEUTRAL_BOSS.id,
  draft: freshDraft(),

  setActive: (id) => set({ activeId: id }),

  saveProfile: (p) =>
    set((s) => ({
      profiles: { ...s.profiles, [p.id]: p },
      activeId: p.id,
      draft: freshDraft(),
    })),

  removeProfile: (id) =>
    set((s) => {
      // neutral 与预设不可删
      if (id === NEUTRAL_BOSS.id || BOSS_PRESETS.some((p) => p.id === id)) return s;
      const next = { ...s.profiles };
      delete next[id];
      return {
        profiles: next,
        activeId: s.activeId === id ? NEUTRAL_BOSS.id : s.activeId,
      };
    }),

  setDraft: (partial) => set((s) => ({ draft: { ...s.draft, ...partial } })),

  resetDraft: () => set({ draft: freshDraft() }),
}));

/** 同步取当前激活原型（供其他 store 在 action 内读取，避免 React hook 依赖）。 */
export function getActiveBossProfile(): BossProfile {
  const s = useBossProfileStore.getState();
  return s.profiles[s.activeId] ?? NEUTRAL_BOSS;
}

/** 列出全部可选原型（neutral 在前，其次预设，其次自定义保存）。 */
export function listBossProfiles(): BossProfile[] {
  const s = useBossProfileStore.getState();
  return Object.values(s.profiles);
}
