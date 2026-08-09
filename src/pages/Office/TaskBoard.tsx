/**
 * src/pages/Office/TaskBoard.tsx
 * 「看板」视图：任务看板（4 列）+ 案件执行过程时间线 + 待审批 list。
 *
 * 数据来自 useApprovalsStore（web 预览下由 task-approval-preview-mock 提供闭环）：
 *   - tasks：KanbanTask[]，按 status 分入 待办/进行中/评审/完成 四列。
 *   - approvals：待审批 list；可一键通过/驳回，回写对应任务。
 * 点击任一任务卡 → 右侧展开执行过程时间线（executionEvents）。
 */
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, XCircle, Clock, ChevronRight, ClipboardList, ShieldAlert } from 'lucide-react';

import { useApprovalsStore } from '@/stores/approvals';
import type { KanbanTask, TaskStatus } from '@/types/task';

const COLUMNS: Array<{ key: TaskStatus; label: string; accent: string }> = [
  { key: 'todo', label: '待办', accent: '#9ca3af' },
  { key: 'in-progress', label: '进行中', accent: '#3b82f6' },
  { key: 'review', label: '评审', accent: '#f59e0b' },
  { key: 'done', label: '完成', accent: '#22c55e' },
];

const PRIORITY_META: Record<KanbanTask['priority'], { label: string; color: string }> = {
  high: { label: '高', color: '#ef4444' },
  medium: { label: '中', color: '#f59e0b' },
  low: { label: '低', color: '#9ca3af' },
};

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export function TaskBoard() {
  const tasks = useApprovalsStore((s) => s.tasks);
  const fetchTasks = useApprovalsStore((s) => s.fetchTasks);
  const approvals = useApprovalsStore((s) => s.approvals);
  const fetchApprovals = useApprovalsStore((s) => s.fetchApprovals);
  const approveItem = useApprovalsStore((s) => s.approveItem);
  const rejectItem = useApprovalsStore((s) => s.rejectItem);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void fetchTasks();
    void fetchApprovals();
  }, [fetchTasks, fetchApprovals]);

  const byStatus = useMemo(() => {
    const map: Record<TaskStatus, KanbanTask[]> = { todo: [], 'in-progress': [], review: [], done: [] };
    for (const t of tasks) map[t.status]?.push(t);
    return map;
  }, [tasks]);

  const selected = tasks.find((t) => t.id === selectedId) ?? null;

  const handleApprove = async (id: string) => {
    await approveItem(id);
    await fetchTasks();
  };
  const handleReject = async (id: string) => {
    await rejectItem(id, '用户驳回');
    await fetchTasks();
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden px-6 py-5">
      {/* 待审批 list */}
      {approvals.length > 0 && (
        <section className="neu-inset shrink-0 rounded-2xl px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" style={{ color: '#f59e0b' }} />
            <h3 className="text-[13px] font-bold" style={{ color: 'var(--neu-ink)' }}>待审批事项</h3>
            <span className="rounded-full px-1.5 py-0.5 text-[10px] font-bold" style={{ backgroundColor: '#f59e0b22', color: '#f59e0b' }}>
              {approvals.length}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {approvals.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-xl px-3 py-2" style={{ background: 'var(--neu-bg, #f1f3f8)' }}>
                <ShieldAlert className="h-4 w-4 shrink-0" style={{ color: '#f59e0b' }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-semibold" style={{ color: 'var(--neu-ink)' }}>{a.prompt ?? a.reason ?? '需要审批'}</p>
                  {a.command && <p className="truncate text-[11px]" style={{ color: 'var(--neu-ink-soft)', fontFamily: 'var(--font-accent)' }}>{a.command}</p>}
                </div>
                <button type="button" onClick={() => void handleApprove(a.id)}
                  className="neu-btn flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold" style={{ color: '#22c55e' }}>
                  <CheckCircle2 className="h-3.5 w-3.5" /> 通过
                </button>
                <button type="button" onClick={() => void handleReject(a.id)}
                  className="neu-btn flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold" style={{ color: '#ef4444' }}>
                  <XCircle className="h-3.5 w-3.5" /> 驳回
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 看板 + 详情 */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* 四列看板 */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((col) => (
            <div key={col.key} className="flex min-h-0 flex-col gap-2">
              <div className="flex items-center gap-2 px-1">
                <span className="h-2 w-2 rounded-full" style={{ background: col.accent }} />
                <span className="text-[12.5px] font-bold" style={{ color: 'var(--neu-ink)' }}>{col.label}</span>
                <span className="text-[11px]" style={{ color: 'var(--neu-ink-soft)' }}>{byStatus[col.key].length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {byStatus[col.key].length === 0 ? (
                  <p className="neu-inset rounded-xl px-3 py-4 text-center text-[11px]" style={{ color: 'var(--neu-ink-soft)' }}>暂无任务</p>
                ) : byStatus[col.key].map((t) => {
                  const pr = PRIORITY_META[t.priority];
                  const waiting = t.workState === 'waiting_approval';
                  return (
                    <button key={t.id} type="button" onClick={() => setSelectedId(t.id)}
                      className={`neu-btn flex flex-col gap-1.5 rounded-xl px-3 py-2.5 text-left ${selectedId === t.id ? 'ring-2' : ''}`}
                      style={{ ...(selectedId === t.id ? { boxShadow: `0 0 0 2px ${col.accent}` } : {}) }}>
                      <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1 text-[13px] font-semibold leading-snug" style={{ color: 'var(--neu-ink)' }}>{t.title}</span>
                        <span className="shrink-0 rounded px-1 py-0.5 text-[9.5px] font-bold" style={{ backgroundColor: `${pr.color}22`, color: pr.color }}>{pr.label}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10.5px]" style={{ color: 'var(--neu-ink-soft)' }}>
                        {t.assigneeRole && <span className="truncate">{t.assigneeRole}</span>}
                        {waiting && <span className="flex items-center gap-0.5" style={{ color: '#f59e0b' }}><Clock className="h-3 w-3" />待审批</span>}
                        <span className="ml-auto flex items-center gap-0.5"><ChevronRight className="h-3 w-3" /></span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* 案件执行过程时间线 */}
        {selected && (
          <aside className="neu-inset flex w-full max-w-[340px] shrink-0 flex-col overflow-hidden rounded-2xl">
            <div className="border-b px-4 py-3" style={{ borderColor: 'color-mix(in srgb, var(--neu-ink-soft) 14%, transparent)' }}>
              <div className="flex items-center gap-2">
                <ClipboardList className="h-4 w-4" style={{ color: 'var(--neu-ink-soft)' }} />
                <h3 className="min-w-0 flex-1 truncate text-[14px] font-bold" style={{ color: 'var(--neu-ink)' }}>{selected.title}</h3>
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--neu-ink-soft)' }}>{selected.description}</p>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              <p className="mb-2 text-[11px] font-semibold" style={{ color: 'var(--neu-ink-soft)' }}>执行过程</p>
              <ol className="relative flex flex-col gap-3 border-l pl-4" style={{ borderColor: 'color-mix(in srgb, var(--neu-ink-soft) 20%, transparent)' }}>
                {(selected.executionEvents ?? []).length === 0 ? (
                  <li className="text-[12px]" style={{ color: 'var(--neu-ink-soft)' }}>尚未开始执行</li>
                ) : (selected.executionEvents ?? []).map((e, i) => (
                  <li key={i} className="relative">
                    <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full"
                      style={{ background: e.status === 'done' ? '#22c55e' : e.status === 'waiting_approval' ? '#f59e0b' : e.status === 'failed' ? '#ef4444' : '#3b82f6' }} />
                    <p className="text-[12px] leading-snug" style={{ color: 'var(--neu-ink)' }}>{e.content}</p>
                    <p className="text-[10px]" style={{ color: 'var(--neu-ink-soft)' }}>{timeAgo(e.createdAt)}</p>
                  </li>
                ))}
              </ol>
              {selected.workResult && (
                <div className="mt-3 rounded-xl px-3 py-2 text-[12px] leading-relaxed" style={{ background: '#22c55e14', color: 'var(--neu-ink)' }}>
                  <span className="font-semibold" style={{ color: '#22c55e' }}>交付结果：</span>{selected.workResult}
                </div>
              )}
              {selected.blocker && (
                <div className="mt-3 rounded-xl px-3 py-2 text-[12px] leading-relaxed" style={{ background: '#f59e0b14', color: 'var(--neu-ink)' }}>
                  <span className="font-semibold" style={{ color: '#f59e0b' }}>等待审批：</span>{selected.blocker.summary}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
