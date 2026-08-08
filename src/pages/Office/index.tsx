/**
 * src/pages/Office/index.tsx
 * Agent Office · 内嵌办公室页面（合并 AgentCorp 评估层 ↔ 办公室工作层的落地点）。
 *
 * 数据闭环（同应用内、真实数据、无 mock）：
 *   评估层 useEvaluationStore.profiles（六维/ROI/生命周期/工种）
 *   + useAgentsStore.agents（姓名/头像/画像）
 *   → computeOfficeRoster：筛出胜出（非 FIRED = MVP/OBSERVE）者
 *   → jobTypeToDept：code→工程部 / image→产品设计 / text→产品规划
 *   → 按部门分组落座上岗。
 *
 * 空态：尚无评估通过的 agent 时，引导用户先去「绩效考核」评估。
 */
import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, ArrowRight } from 'lucide-react';

import { useEvaluationStore } from '@/stores/evaluation';
import { useAgentsStore } from '@/stores/agents';
import {
  computeOfficeRoster,
  groupByDept,
  OFFICE_DEPTS,
} from '@/engine/office/assignment';
import { OfficeEmployeeCard } from './OfficeEmployeeCard';

export function Office() {
  const navigate = useNavigate();
  const profiles = useEvaluationStore((s) => s.profiles);
  const loadAll = useEvaluationStore((s) => s.loadAll);
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  // 挂载时确保评估档案与 agent 列表已就绪（幂等）。
  useEffect(() => {
    void loadAll();
    void fetchAgents();
  }, [loadAll, fetchAgents]);

  const roster = useMemo(
    () => computeOfficeRoster(profiles, agents),
    [profiles, agents],
  );
  const grouped = useMemo(() => groupByDept(roster), [roster]);

  const total = roster.length;
  const mvpCount = roster.filter((e) => e.isMvp).length;

  return (
    <div className="tech-bg flex h-full flex-col overflow-hidden">
      {/* 顶部横幅 */}
      <header
        className="flex shrink-0 items-center gap-3 border-b px-6 py-4"
        style={{ borderColor: 'color-mix(in srgb, var(--neu-ink-soft) 14%, transparent)' }}
      >
        <div
          className="neu-inset flex h-10 w-10 items-center justify-center rounded-xl"
          style={{ color: 'var(--neu-ink)' }}
        >
          <Building2 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1
            className="text-[17px] font-bold leading-tight"
            style={{ color: 'var(--neu-ink)' }}
            translate="no"
          >
            Agent Office · 办公室
          </h1>
          <p className="text-[12px]" style={{ color: 'var(--neu-ink-soft)' }}>
            通过 HR 评估的 agent 已按工种自动入职上岗
          </p>
        </div>
        <div className="hidden items-center gap-4 sm:flex">
          <Stat label="在岗员工" value={total} />
          <Stat label="MVP" value={mvpCount} accent={OFFICE_DEPTS.engineering.accent} />
        </div>
      </header>

      {/* 主体 */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {total === 0 ? (
          <EmptyState onGo={() => navigate('/evaluation')} />
        ) : (
          <div className="flex flex-col gap-6">
            {grouped.map(({ dept, members }) => {
              const meta = OFFICE_DEPTS[dept];
              return (
                <section key={dept} className="flex flex-col gap-3">
                  {/* 部门表头 */}
                  <div className="flex items-center gap-2.5">
                    <span
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-[15px]"
                      style={{ backgroundColor: `${meta.accent}22`, color: meta.accent }}
                    >
                      {meta.glyph}
                    </span>
                    <div className="flex items-baseline gap-2">
                      <h2
                        className="text-[15px] font-bold"
                        style={{ color: 'var(--neu-ink)' }}
                        translate="no"
                      >
                        {meta.label}
                      </h2>
                      <span
                        className="text-[11px]"
                        style={{ color: 'var(--neu-ink-soft)', fontFamily: 'var(--font-accent)' }}
                        translate="no"
                      >
                        {meta.en} · {members.length} 人
                      </span>
                    </div>
                  </div>

                  {members.length === 0 ? (
                    <p
                      className="neu-inset rounded-xl px-4 py-3 text-[12px]"
                      style={{ color: 'var(--neu-ink-soft)' }}
                    >
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
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="flex flex-col items-end leading-tight">
      <span
        className="text-[18px] font-bold tabular-nums"
        style={{ color: accent ?? 'var(--neu-ink)', fontFamily: 'var(--font-accent)' }}
      >
        {value}
      </span>
      <span className="text-[10.5px]" style={{ color: 'var(--neu-ink-soft)' }}>
        {label}
      </span>
    </div>
  );
}

function EmptyState({ onGo }: { onGo: () => void }) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-4 text-center">
      <div
        className="neu-inset flex h-16 w-16 items-center justify-center rounded-2xl"
        style={{ color: 'var(--neu-ink-soft)' }}
      >
        <Building2 className="h-8 w-8" />
      </div>
      <div className="max-w-sm">
        <h2 className="text-[16px] font-bold" style={{ color: 'var(--neu-ink)' }}>
          办公室还没有员工
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--neu-ink-soft)' }}>
          先在「绩效考核」里对候选 agent 层层筛选，通过评估（MVP / 待观察）的 agent
          会按工种自动入职到这里的对应部门。
        </p>
      </div>
      <button
        type="button"
        onClick={onGo}
        className="neu-btn flex items-center gap-2 rounded-xl px-4 py-2 text-[13px] font-semibold"
        style={{ color: 'var(--neu-ink)' }}
      >
        去评估 agent
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}

export default Office;
