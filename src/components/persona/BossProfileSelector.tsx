/**
 * src/components/persona/BossProfileSelector.tsx
 * 老板原型选择器（A · 人格化评估的入口 UI）。
 *
 * 功能：
 * - 下拉选择激活的老板原型（neutral 基线 + 预设 + 已保存自定义）；
 * - 「新建自定义老板」展开表单：领域 / 经验 / 风险 / 沟通 / 约束偏好；
 * - 保存后落入 bossProfile store 并设为激活，立即影响面试选题与裁判视角。
 *
 * 样式：复用既有页面工具类（rounded-2xl / bg-white/70 / border-white/40），不引入新范式，
 * 保证 tsc 与构建稳定。语义色用墨色（neu-ink），不依赖灰色弱文字。
 */
import { useState } from 'react';
import {
  useBossProfileStore,
  listBossProfiles,
  BOSS_PRESETS,
} from '@/stores/bossProfile';
import type {
  BossProfile,
  CommunicationStyle,
  ExperienceLevel,
  RiskAversion,
} from '@/types/evaluation';
import { NEUTRAL_BOSS } from '@/types/evaluation';

const EXPERIENCE_OPTS: { value: ExperienceLevel; label: string }[] = [
  { value: 'novice', label: '新手' },
  { value: 'intermediate', label: '中级' },
  { value: 'expert', label: '专家' },
];
const RISK_OPTS: { value: RiskAversion; label: string }[] = [
  { value: 'low', label: '低风险偏好' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高风险厌恶' },
];
const COMM_OPTS: { value: CommunicationStyle; label: string }[] = [
  { value: 'concise', label: '简洁' },
  { value: 'detailed', label: '详尽' },
  { value: 'socratic', label: '苏格拉底式' },
];
const CONSTRAINT_OPTS: { value: string; label: string }[] = [
  { value: 'cost', label: '性价比' },
  { value: 'speed', label: '速度' },
  { value: 'quality', label: '质量' },
  { value: 'safety', label: '安全/合规' },
];

/** 原生 select 的统一样式（复用页面工具类） */
const SELECT_CLS =
  'rounded-xl border border-white/40 bg-white/60 px-3 py-2 text-[13px] text-[#1A1C1E] dark:text-white outline-none';
const LABEL_CLS = 'text-[11px] font-bold uppercase tracking-wider text-[#6b6250] dark:text-[#454b54]';

export function BossProfileSelector() {
  const activeId = useBossProfileStore((s) => s.activeId);
  const setActive = useBossProfileStore((s) => s.setActive);
  const draft = useBossProfileStore((s) => s.draft);
  const setDraft = useBossProfileStore((s) => s.setDraft);
  const saveProfile = useBossProfileStore((s) => s.saveProfile);
  const resetDraft = useBossProfileStore((s) => s.resetDraft);

  const [editing, setEditing] = useState(false);

  const options = listBossProfiles();

  const toggleConstraint = (c: string) => {
    const has = (draft.constraintPrefs ?? []).includes(c);
    const next = has
      ? (draft.constraintPrefs ?? []).filter((x) => x !== c)
      : [...(draft.constraintPrefs ?? []), c];
    setDraft({ constraintPrefs: next });
  };

  const handleSave = () => {
    const toSave: BossProfile = {
      ...draft,
      id: draft.id || `boss-custom-${Date.now()}`,
      name: draft.name?.trim() || '自定义老板',
    };
    saveProfile(toSave);
    setEditing(false);
  };

  return (
    <div className="rounded-2xl border border-white/40 bg-white/70 p-3 dark:bg-white/5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-bold text-[#1A1C1E] dark:text-white">
          老板原型 · 与谁协作
        </span>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-full bg-[#efe7d8] px-3 py-1 text-[12px] font-bold text-[#514a39] dark:bg-[#e0e5ec] dark:text-[#1a1c1e]"
          >
            ＋ 新建
          </button>
        ) : null}
      </div>

      {!editing ? (
        <select
          className={SELECT_CLS + ' w-full'}
          value={activeId}
          onChange={(e) => setActive(e.target.value)}
          aria-label="选择老板原型"
        >
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === NEUTRAL_BOSS.id ? '中性（无个性化基线）' : p.name ?? p.id}
              {BOSS_PRESETS.some((x) => x.id === p.id) ? ' · 预设' : p.id.startsWith('boss-custom') ? ' · 自定义' : ''}
            </option>
          ))}
        </select>
      ) : (
        <div className="space-y-3">
          <div>
            <label className={LABEL_CLS}>名称</label>
            <input
              className={SELECT_CLS + ' w-full'}
              value={draft.name ?? ''}
              placeholder="自定义老板"
              onChange={(e) => setDraft({ name: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL_CLS}>领域</label>
            <input
              className={SELECT_CLS + ' w-full'}
              value={draft.domain ?? ''}
              placeholder="如 电商增长 / 学术研究"
              onChange={(e) => setDraft({ domain: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className={LABEL_CLS}>经验</label>
              <select
                className={SELECT_CLS + ' w-full'}
                value={draft.experienceLevel ?? 'intermediate'}
                onChange={(e) => setDraft({ experienceLevel: e.target.value as ExperienceLevel })}
              >
                {EXPERIENCE_OPTS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL_CLS}>风险</label>
              <select
                className={SELECT_CLS + ' w-full'}
                value={draft.riskAversion ?? 'medium'}
                onChange={(e) => setDraft({ riskAversion: e.target.value as RiskAversion })}
              >
                {RISK_OPTS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL_CLS}>沟通</label>
              <select
                className={SELECT_CLS + ' w-full'}
                value={draft.communicationStyle ?? 'detailed'}
                onChange={(e) => setDraft({ communicationStyle: e.target.value as CommunicationStyle })}
              >
                {COMM_OPTS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className={LABEL_CLS}>约束偏好</label>
            <div className="mt-1 flex flex-wrap gap-2">
              {CONSTRAINT_OPTS.map((o) => {
                const on = (draft.constraintPrefs ?? []).includes(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => toggleConstraint(o.value)}
                    className={
                      'rounded-full px-3 py-1 text-[12px] font-bold ' +
                      (on
                        ? 'bg-[#514a39] text-[#efe7d8]'
                        : 'bg-[#efe7d8] text-[#514a39] dark:bg-[#e0e5ec] dark:text-[#1a1c1e]')
                    }
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              className="flex-1 rounded-full bg-[#514a39] px-3 py-1.5 text-[12px] font-bold text-[#efe7d8]"
            >
              保存并启用
            </button>
            <button
              type="button"
              onClick={() => {
                resetDraft();
                setEditing(false);
              }}
              className="rounded-full bg-white/60 px-3 py-1.5 text-[12px] font-bold text-[#514a39]"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-[#6b6250] dark:text-[#454b54]">
        评估结果随原型而变：面试选题与裁判视角都会站在「这位老板」的立场。
      </p>
    </div>
  );
}

export default BossProfileSelector;
