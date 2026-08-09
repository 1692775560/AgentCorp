/**
 * src/pages/Office/DepartmentPanel.tsx
 * 点击像素办公室的部门区域（chip）后，从右侧滑出该部门的人员安排面板：
 * 列出该部门已入职员工（风格化卡片），点击某人可直接派活。
 */
import { X, Users } from 'lucide-react';

import { OFFICE_DEPTS, VERDICT_META, type OfficeDept, type OfficeEmployee } from '@/engine/office/assignment';

/** 布局区域英文 label → AgentCorp 部门（未映射的区域返回 null）。 */
export function areaLabelToDept(label: string): OfficeDept | null {
  switch (label) {
    case 'Engineering': return 'engineering';
    case 'Design':      return 'design';
    case 'PM':          return 'pm';
    default:            return null; // QA / Finance / Operations / Lobby / Meeting Room 暂无映射
  }
}

/** 区域英文 label → 中文展示名（含未映射区域）。 */
export function areaLabelToName(label: string): string {
  const dept = areaLabelToDept(label);
  if (dept) return OFFICE_DEPTS[dept].label;
  const extra: Record<string, string> = {
    QA: '质量保证',
    Finance: '财务室',
    Operations: '运营部',
    Lobby: '大厅',
    'Meeting Room': '会议室',
  };
  return extra[label] ?? label;
}

interface DepartmentPanelProps {
  areaLabel: string;
  roster: OfficeEmployee[];
  onClose: () => void;
  onSelectAgent: (agentId: string) => void;
}

export function DepartmentPanel({ areaLabel, roster, onClose, onSelectAgent }: DepartmentPanelProps) {
  const dept = areaLabelToDept(areaLabel);
  const name = areaLabelToName(areaLabel);
  const accent = dept ? OFFICE_DEPTS[dept].accent : '#9ca3af';
  const members = dept ? roster.filter((e) => e.dept === dept) : [];

  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[380px] flex-col shadow-2xl"
      style={{ background: 'var(--neu-bg, #f1f3f8)' }}>
      {/* 头部 */}
      <div className="flex items-center gap-3 border-b px-5 py-4"
        style={{ borderColor: 'color-mix(in srgb, var(--neu-ink-soft) 14%, transparent)' }}>
        <span className="flex h-9 w-9 items-center justify-center rounded-xl text-[16px]"
          style={{ backgroundColor: `${accent}22`, color: accent }}>
          {dept ? OFFICE_DEPTS[dept].glyph : '○'}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-bold leading-tight" style={{ color: 'var(--neu-ink)' }}>{name}</h2>
          <p className="text-[11.5px]" style={{ color: 'var(--neu-ink-soft)' }}>
            {dept ? `${OFFICE_DEPTS[dept].en} · ${members.length} 名在岗员工` : '该区域暂未承接工种'}
          </p>
        </div>
        <button type="button" onClick={onClose}
          className="neu-btn flex h-8 w-8 items-center justify-center rounded-lg" style={{ color: 'var(--neu-ink-soft)' }}>
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 人员列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {members.length === 0 ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 text-center">
            <div className="neu-inset flex h-12 w-12 items-center justify-center rounded-2xl" style={{ color: 'var(--neu-ink-soft)' }}>
              <Users className="h-6 w-6" />
            </div>
            <p className="max-w-[220px] text-[12.5px] leading-relaxed" style={{ color: 'var(--neu-ink-soft)' }}>
              {dept ? '该部门暂无入职员工，去评估通过后会自动上岗。' : '该区域暂无固定工种，通过评估的 agent 会归入工程 / 设计 / 规划三大部门。'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {members.map((emp) => {
              const v = VERDICT_META[emp.verdict];
              return (
                <button
                  key={emp.agentId}
                  type="button"
                  onClick={() => onSelectAgent(emp.agentId)}
                  className="neu-btn flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-transform hover:translate-x-0.5"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[13px] font-bold"
                    style={{ backgroundColor: `${accent}22`, color: accent }}>
                    {emp.name.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-semibold" style={{ color: 'var(--neu-ink)' }}>{emp.name}</span>
                      <span className="shrink-0 rounded px-1 py-0.5 text-[9.5px] font-bold"
                        style={{ backgroundColor: `${v.color}22`, color: v.color }}>{v.glyph} {v.label}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11px]" style={{ color: 'var(--neu-ink-soft)' }}>{emp.bio}</span>
                  </span>
                  <span className="shrink-0 text-right leading-tight">
                    <span className="block text-[14px] font-bold tabular-nums" style={{ color: accent, fontFamily: 'var(--font-accent)' }}>{emp.userFit}</span>
                    <span className="block text-[9px]" style={{ color: 'var(--neu-ink-soft)' }}>契合度</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="border-t px-5 py-3 text-center text-[11px]"
        style={{ borderColor: 'color-mix(in srgb, var(--neu-ink-soft) 14%, transparent)', color: 'var(--neu-ink-soft)' }}>
        点击任一员工即可派活
      </div>
    </div>
  );
}
