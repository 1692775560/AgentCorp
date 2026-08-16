/**
 * src/pages/Office/TaskBoard.tsx
 * 「看板」视图：任务看板（4 列）+ 案件执行过程时间线 + 待审批 list。
 *
 * 数据来自 useApprovalsStore（web 预览下由 task-approval-preview-mock 提供闭环）：
 *   - tasks：KanbanTask[]，按 status 分入 待办/进行中/评审/完成 四列。
 *   - approvals：待审批 list；可一键通过/驳回，回写对应任务。
 * 点击任一任务卡 → 右侧展开执行过程时间线（executionEvents）。
 */
import { useCallback, useEffect, useMemo, useState, memo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, XCircle, Clock, ChevronRight, ClipboardList, ShieldAlert, Plus, X, Users, FolderOpen, Download, Globe } from 'lucide-react';

import { useApprovalsStore } from '@/stores/approvals';
import { useTeamsStore } from '@/stores/teams';
import type { KanbanTask, TaskStatus } from '@/types/task';
import type { TeamSummary } from '@/types/team';
import { AutoWorkerBar } from './AutoWorkerBar';
import MarkdownContent from '@/pages/Chat/MarkdownContent';
import { invokeIpc } from '@/lib/api-client';

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

/**
 * 单个任务卡片（memo）：编排期间任务数组高频更新时，
 * 未变化的任务引用不变（applyTaskSnapshotResponse 保留引用），
 * memo 直接跳过重渲染，避免整板跟着执行时间线一起刷。
 */
const TaskCard = memo(function TaskCard({
  task: t,
  selected,
  accent,
  onSelect,
  onRetry,
}: {
  task: KanbanTask;
  selected: boolean;
  accent: string;
  onSelect: (taskId: string) => void;
  onRetry: (taskId: string) => void;
}) {
  const pr = PRIORITY_META[t.priority];
  const waiting = t.workState === 'waiting_approval';
  return (
    <button type="button" onClick={() => onSelect(t.id)}
      className={`neu-btn flex flex-col gap-1.5 rounded-xl px-3 py-2.5 text-left ${selected ? 'ring-2' : ''}`}
      style={{ ...(selected ? { boxShadow: `0 0 0 2px ${accent}` } : {}) }}>
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[13px] font-semibold leading-snug" style={{ color: 'var(--neu-ink)' }}>{t.title}</span>
        <span className="shrink-0 rounded px-1 py-0.5 text-[9.5px] font-bold" style={{ backgroundColor: `${pr.color}22`, color: pr.color }}>{pr.label}</span>
      </div>
      <div className="flex items-center gap-2 text-[10.5px]" style={{ color: 'var(--neu-ink-soft)' }}>
        {t.assigneeRole && <span className="truncate">{t.assigneeRole}</span>}
        {t.isTeamTask && <span className="rounded px-1 py-px text-[9px] font-bold" style={{ background: '#6366f122', color: '#6366f1' }}>A2A协作</span>}
        {waiting && <span className="flex items-center gap-0.5" style={{ color: '#f59e0b' }}><Clock className="h-3 w-3" />待审批</span>}
        {t.workState === 'failed' && (
          // 失败任务（含重试上限后停住的）一键重新排队，AutoWorker 下一轮自动领取
          <span
            role="button"
            title={t.workError ?? '执行失败'}
            onClick={(e) => {
              e.stopPropagation();
              onRetry(t.id);
            }}
            className="flex cursor-pointer items-center gap-0.5 rounded px-1 py-px text-[9.5px] font-bold"
            style={{ background: '#ef444422', color: '#ef4444' }}
          >
            失败·点我重试
          </span>
        )}
        <span className="ml-auto flex items-center gap-0.5"><ChevronRight className="h-3 w-3" /></span>
      </div>
    </button>
  );
});

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

/**
 * 新建团队任务弹窗：选择团队 + 标题 + 描述，提交后进入看板「待办」列，
 * AutoWorker 开启时由团队 leader 自动接管多 agent 协作。
 */
function CreateTeamTaskModal({ teams, onClose }: { teams: TeamSummary[]; onClose: () => void }) {
  const navigate = useNavigate();
  const createTask = useApprovalsStore((s) => s.createTask);
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const team = teams.find((t) => t.id === teamId);
    if (!team || !title.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // createTask 后端落 status:'todo'，且 isTeamTask = Boolean(teamId)
      // （见 electron/utils/task-config.ts），这里只需带上团队元信息。
      await createTask({
        title: title.trim(),
        description: description.trim(),
        priority: 'medium',
        teamId: team.id,
        teamName: team.name,
      });
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="neu-inset flex w-full max-w-md flex-col gap-4 rounded-2xl p-5"
        style={{ background: 'var(--neu-bg, #f1f3f8)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-[15px] font-bold" style={{ color: 'var(--neu-ink)' }}>新建团队任务</h3>
          <button type="button" onClick={onClose}
            className="neu-btn flex h-7 w-7 items-center justify-center rounded-lg" style={{ color: 'var(--neu-ink-soft)' }}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {teams.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--neu-ink-soft)' }}>
              暂无可下发任务的团队。注意：单独雇佣的 agent 不算团队——需要先把 1 个 leader 和至少
              1 名成员组建成一个团队，才能下发团队任务。
            </p>
            <button
              type="button"
              onClick={() => {
                onClose();
                navigate('/team-builder');
              }}
              className="neu-btn flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-[13px] font-semibold text-white"
              style={{ background: '#6366f1' }}
            >
              <Users className="h-4 w-4" />
              去组建团队
            </button>
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-semibold" style={{ color: 'var(--neu-ink-soft)' }}>选择团队</span>
              <select
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                className="neu-inset w-full rounded-xl px-3 py-2 text-[13px] outline-none"
                style={{ color: 'var(--neu-ink)' }}
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}（leader：{t.leaderName}，{t.memberIds.length} 名成员）
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-semibold" style={{ color: 'var(--neu-ink-soft)' }}>任务标题</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：整理本周销售数据报告"
                className="neu-inset w-full rounded-xl px-3 py-2 text-[13px] outline-none"
                style={{ color: 'var(--neu-ink)' }}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-semibold" style={{ color: 'var(--neu-ink-soft)' }}>任务描述</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="补充任务背景、交付要求等（可选）"
                rows={4}
                className="neu-inset w-full resize-none rounded-xl px-3 py-2 text-[13px] outline-none"
                style={{ color: 'var(--neu-ink)' }}
              />
            </label>
            {error && (
              <p className="text-[12px]" style={{ color: '#ef4444' }}>创建失败：{error}</p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose}
                className="neu-btn rounded-lg px-3.5 py-1.5 text-[12px] font-semibold" style={{ color: 'var(--neu-ink-soft)' }}>
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={submitting || !title.trim() || !teamId}
                className="neu-btn rounded-lg px-3.5 py-1.5 text-[12px] font-semibold disabled:opacity-50"
                style={{ color: '#6366f1' }}
              >
                {submitting ? '创建中…' : '创建任务'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function TaskBoard() {
  const tasks = useApprovalsStore((s) => s.tasks);
  const fetchTasks = useApprovalsStore((s) => s.fetchTasks);
  const approvals = useApprovalsStore((s) => s.approvals);
  const fetchApprovals = useApprovalsStore((s) => s.fetchApprovals);
  const approveItem = useApprovalsStore((s) => s.approveItem);
  const rejectItem = useApprovalsStore((s) => s.rejectItem);
  const updateTask = useApprovalsStore((s) => s.updateTask);
  const teams = useTeamsStore((s) => s.teams);
  const fetchTeams = useTeamsStore((s) => s.fetchTeams);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  // 系统通知点击跳转：/kanban?task=<id> → 自动选中该任务展开详情，随后清掉参数
  useEffect(() => {
    const taskId = searchParams.get('task');
    if (taskId) {
      setSelectedId(taskId);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const handleDownloadZip = async (taskId: string) => {
    if (zipping) return;
    setZipping(true);
    setZipError(null);
    try {
      const res = await invokeIpc('task:zipDeliverables', { taskId }) as { success: boolean; zipPath?: string; error?: string };
      if (res?.success && res.zipPath) {
        await invokeIpc('shell:showItemInFolder', res.zipPath);
      } else {
        setZipError(res?.error || '打包失败');
      }
    } catch (err) {
      setZipError(String(err));
    } finally {
      setZipping(false);
    }
  };

  // HTML 交付物直接用默认浏览器打开（没有 HTML 时如实提示）
  const handleOpenHtml = async (taskId: string) => {
    setZipError(null);
    try {
      const res = await invokeIpc('task:openHtmlDeliverable', { taskId }) as { success: boolean; error?: string };
      if (!res?.success) setZipError(res?.error || '打开失败');
    } catch (err) {
      setZipError(String(err));
    }
  };

  useEffect(() => {
    void fetchTasks();
    void fetchApprovals();
    void fetchTeams();
  }, [fetchTasks, fetchApprovals, fetchTeams]);

  // 只列出可下发任务的团队：有 leader 且至少 1 名成员
  const eligibleTeams = useMemo(
    () => teams.filter((t) => t.leaderId && t.memberIds.length >= 1),
    [teams],
  );

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

  // 卡片回调保持稳定引用，配合 TaskCard memo 在任务高频更新时跳过重渲染
  const handleSelectTask = useCallback((taskId: string) => setSelectedId(taskId), []);
  const handleRetryTask = useCallback(
    (taskId: string) => {
      void updateTask(taskId, { status: 'todo', workState: 'idle' }).then(() => fetchTasks());
    },
    [updateTask, fetchTasks],
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden px-6 py-5">
      {/* 自动任务 worker 控制条（S8/S9/S10）+ 团队任务发起入口 */}
      <div className="flex shrink-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <AutoWorkerBar />
        </div>
        <button type="button" onClick={() => setTeamModalOpen(true)}
          className="neu-btn flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold" style={{ color: '#6366f1' }}>
          <Plus className="h-3.5 w-3.5" /> 新建团队任务
        </button>
      </div>

      {teamModalOpen && (
        <CreateTeamTaskModal teams={eligibleTeams} onClose={() => setTeamModalOpen(false)} />
      )}

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
                ) : byStatus[col.key].map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    selected={selectedId === t.id}
                    accent={col.accent}
                    onSelect={handleSelectTask}
                    onRetry={handleRetryTask}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* 案件执行过程时间线 */}
        {selected && (
          <aside className="neu-inset flex w-full max-w-[420px] shrink-0 flex-col overflow-hidden rounded-2xl">
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
                ) : (selected.executionEvents ?? []).map((e, i) => {
                  const isA2a = typeof e.type === 'string' && e.type.startsWith('a2a:');
                  const route = isA2a ? e.type.slice(4) : '';
                  const isReview = isA2a && (e.content?.includes('PASS') || e.content?.includes('REWORK'));
                  const passed = !!e.content?.includes('PASS');
                  return (
                  <li key={i} className="relative">
                    <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full"
                      style={{ background: e.status === 'done' ? '#22c55e' : e.status === 'waiting_approval' ? '#f59e0b' : e.status === 'failed' ? '#ef4444' : '#3b82f6' }} />
                    {isA2a && (
                      <div className="mb-0.5 flex items-center gap-1 text-[9.5px] font-semibold" style={{ color: isReview ? (passed ? '#22c55e' : '#f59e0b') : '#6366f1' }}>
                        <span className="rounded px-1 py-px" style={{ background: isReview ? (passed ? '#22c55e22' : '#f59e0b22') : '#6366f122' }}>A2A</span>
                        <span className="truncate">{route}</span>
                      </div>
                    )}
                    <p className="text-[12px] leading-snug" style={{ color: 'var(--neu-ink)' }}>{e.content}</p>
                    <p className="text-[10px]" style={{ color: 'var(--neu-ink-soft)' }}>{timeAgo(e.createdAt)}</p>
                  </li>
                  );
                })}
              </ol>
              {selected.workResult && (
                <div className="mt-3 rounded-xl px-3 py-2" style={{ background: '#22c55e14' }}>
                  <p className="mb-1.5 text-[11px] font-semibold" style={{ color: '#22c55e' }}>交付结果</p>
                  <MarkdownContent content={selected.workResult} className="text-[12.5px] leading-relaxed" />
                  {selected.deliverableDir && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void invokeIpc('shell:openPath', selected.deliverableDir)}
                        className="neu-btn flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11.5px] font-semibold"
                        style={{ color: '#22c55e' }}
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        打开交付目录（{selected.deliverableDir.split('/').pop()}）
                      </button>
                      <button
                        type="button"
                        disabled={zipping}
                        onClick={() => void handleDownloadZip(selected.id)}
                        className="neu-btn flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11.5px] font-semibold disabled:opacity-50"
                        style={{ color: '#6366f1' }}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {zipping ? '打包中…' : '下载 ZIP'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleOpenHtml(selected.id)}
                        className="neu-btn flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11.5px] font-semibold"
                        style={{ color: '#f59e0b' }}
                      >
                        <Globe className="h-3.5 w-3.5" />
                        在浏览器打开
                      </button>
                      {zipError && (
                        <span className="text-[11px]" style={{ color: '#ef4444' }}>{zipError}</span>
                      )}
                    </div>
                  )}
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
