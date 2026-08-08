/**
 * src/pages/Office/index.tsx
 * Agent Office · 内嵌像素办公室页面。
 *
 * 数据闭环（同应用内、真实数据）：
 *   评估层 profiles + agents → computeOfficeRoster（胜出=MVP/OBSERVE）
 *   → 按工种映射部门（code→工程 / image→设计 / text→规划）
 *   → 像素办公室：真实 agent 按部门落座（PixelOffice + 像素引擎）
 *   → 点选像素角色 → 派活抽屉（走 gateway chat.send 真实调度）。
 *
 * 视图：默认「像素」画布；可切到「卡片」查看六维/派活明细。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, ArrowRight, LayoutGrid, Gamepad2, KanbanSquare } from 'lucide-react';

import { useEvaluationStore } from '@/stores/evaluation';
import { useAgentsStore } from '@/stores/agents';
import { computeOfficeRoster, groupByDept, OFFICE_DEPTS } from '@/engine/office/assignment';
import { OfficeEmployeeCard } from './OfficeEmployeeCard';
import { PixelOffice } from './PixelOffice';
import { AgentDispatchDrawer } from './AgentDispatchDrawer';
import { DepartmentPanel } from './DepartmentPanel';
import { TaskBoard } from './TaskBoard';

type View = 'pixel' | 'board' | 'cards';

export function Office() {
  const navigate = useNavigate();
  const profiles = useEvaluationStore((s) => s.profiles);
  const loadAll = useEvaluationStore((s) => s.loadAll);
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  const [view, setView] = useState<View>('pixel');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [deptAreaLabel, setDeptAreaLabel] = useState<string | null>(null);

  useEffect(() => {
    void loadAll();
    void fetchAgents();
  }, [loadAll, fetchAgents]);

  const roster = useMemo(() => computeOfficeRoster(profiles, agents), [profiles, agents]);
  const grouped = useMemo(() => groupByDept(roster), [roster]);
  const total = roster.length;
  const mvpCount = roster.filter((e) => e.isMvp).length;
  const selectedEmp = roster.find((e) => e.agentId === selectedAgentId) ?? null;

  return (
    <div className="tech-bg flex h-full flex-col overflow-hidden">
      {/* 顶部横幅 */}
      <header
        className="flex shrink-0 items-center gap-3 border-b px-6 py-4"
        style={{ borderColor: 'color-mix(in srgb, var(--neu-ink-soft) 14%, transparent)' }}
      >
        <div className="neu-inset flex h-10 w-10 items-center justify-center rounded-xl" style={{ color: 'var(--neu-ink)' }}>
          <Building2 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[17px] font-bold leading-tight" style={{ color: 'var(--neu-ink)' }} translate="no">
            Agent Office · 办公室
          </h1>
          <p className="text-[12px]" style={{ color: 'var(--neu-ink-soft)' }}>
            通过 HR 评估的 agent 已按工种自动入职上岗 · 点角色可派活
          </p>
        </div>
        {/* 视图切换 */}
        <div className="neu-inset flex items-center gap-1 rounded-xl p-1">
          <ViewTab active={view === 'pixel'} onClick={() => setView('pixel')} icon={<Gamepad2 className="h-3.5 w-3.5" />} label="像素" />
          <ViewTab active={view === 'board'} onClick={() => setView('board')} icon={<KanbanSquare className="h-3.5 w-3.5" />} label="看板" />
          <ViewTab active={view === 'cards'} onClick={() => setView('cards')} icon={<LayoutGrid className="h-3.5 w-3.5" />} label="卡片" />
        </div>
        <div className="ml-2 hidden items-center gap-4 sm:flex">
          <Stat label="在岗员工" value={total} />
          <Stat label="MVP" value={mvpCount} accent={OFFICE_DEPTS.engineering.accent} />
        </div>
      </header>

      {/* 主体 */}
      <div className="relative flex-1 overflow-hidden">
        {total === 0 ? (
          <div className="h-full overflow-y-auto px-6 py-5">
            <EmptyState onGo={() => navigate('/evaluation')} />
          </div>
        ) : view === 'pixel' ? (
          <PixelOffice roster={roster} onSelectAgent={setSelectedAgentId} onOpenDepartment={setDeptAreaLabel} />
        ) : view === 'board' ? (
          <TaskBoard />
        ) : (
          <div className="h-full overflow-y-auto px-6 py-5">
            <div className="flex flex-col gap-6">
              {grouped.map(({ dept, members }) => {
                const meta = OFFICE_DEPTS[dept];
                return (
                  <section key={dept} className="flex flex-col gap-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg text-[15px]" style={{ backgroundColor: `${meta.accent}22`, color: meta.accent }}>
                        {meta.glyph}
                      </span>
                      <div className="flex items-baseline gap-2">
                        <h2 className="text-[15px] font-bold" style={{ color: 'var(--neu-ink)' }} translate="no">{meta.label}</h2>
                        <span className="text-[11px]" style={{ color: 'var(--neu-ink-soft)', fontFamily: 'var(--font-accent)' }} translate="no">
                          {meta.en} · {members.length} 人
                        </span>
                      </div>
                    </div>
                    {members.length === 0 ? (
                      <p className="neu-inset rounded-xl px-4 py-3 text-[12px]" style={{ color: 'var(--neu-ink-soft)' }}>
                        暂无入职员工 · {meta.desc}
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        {members.map((emp) => (
                          <OfficeEmployeeCard key={emp.agentId} emp={emp} accent={meta.accent} />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </div>
        )}

        {/* 像素视图下点角色 → 派活抽屉 */}
        {selectedEmp && (
          <AgentDispatchDrawer emp={selectedEmp} onClose={() => setSelectedAgentId(null)} />
        )}
      </div>
    </div>
  );
}

function ViewTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${active ? 'glass-panel' : ''}`}
      style={{ color: active ? 'var(--neu-ink)' : 'var(--neu-ink-soft)' }}
    >
      {icon}
      {label}
    </button>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className="text-[18px] font-bold tabular-nums" style={{ color: accent ?? 'var(--neu-ink)', fontFamily: 'var(--font-accent)' }}>
        {value}
      </span>
      <span className="text-[10.5px]" style={{ color: 'var(--neu-ink-soft)' }}>{label}</span>
    </div>
  );
}

function EmptyState({ onGo }: { onGo: () => void }) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-4 text-center">
      <div className="neu-inset flex h-16 w-16 items-center justify-center rounded-2xl" style={{ color: 'var(--neu-ink-soft)' }}>
        <Building2 className="h-8 w-8" />
      </div>
      <div className="max-w-sm">
        <h2 className="text-[16px] font-bold" style={{ color: 'var(--neu-ink)' }}>办公室还没有员工</h2>
        <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--neu-ink-soft)' }}>
          先在「绩效考核」里对候选 agent 层层筛选，通过评估（MVP / 待观察）的 agent 会按工种自动入职到这里的对应部门。
        </p>
      </div>
      <button type="button" onClick={onGo} className="neu-btn flex items-center gap-2 rounded-xl px-4 py-2 text-[13px] font-semibold" style={{ color: 'var(--neu-ink)' }}>
        去评估 agent
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}

export default Office;
