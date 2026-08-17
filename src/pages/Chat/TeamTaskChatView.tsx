/**
 * src/pages/Chat/TeamTaskChatView.tsx
 * 团队任务会话视图：把看板任务的 A2A 协作过程渲染成群聊。
 *
 * 数据来自 useApprovalsStore 的任务执行事件（autoWorker 节流写回），
 * 随任务推进实时刷新；不经过网关消息通道。输入由 Chat 页替换成提示条——
 * 团队任务由编排器自动推进，需要沟通可走成员私聊。
 */
import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardCheck, Users } from 'lucide-react';

import { useApprovalsStore } from '@/stores/approvals';
import { useAgentsStore } from '@/stores/agents';
import { useTeamsStore } from '@/stores/teams';
import MarkdownContent from '@/pages/Chat/MarkdownContent';
import { mapEventsToTeamChatBubbles } from '@/lib/team-task-chat';
import { summarizeA2aEvents } from '@/lib/a2a-timeline';
import type { KanbanTask } from '@/types/task';

const STATUS_META: Record<KanbanTask['status'], { label: string; color: string }> = {
  todo: { label: '待办', color: '#9ca3af' },
  'in-progress': { label: '进行中', color: '#3b82f6' },
  review: { label: '待验收', color: '#f59e0b' },
  done: { label: '已完成', color: '#22c55e' },
};

export function TeamTaskChatView({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  const tasks = useApprovalsStore((s) => s.tasks);
  const fetchTasks = useApprovalsStore((s) => s.fetchTasks);
  const agents = useAgentsStore((s) => s.agents);
  const teams = useTeamsStore((s) => s.teams);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  const task = tasks.find((t) => t.id === taskId) ?? null;
  const leaderId = task?.teamId
    ? teams.find((t) => t.id === task.teamId)?.leaderId ?? null
    : null;

  const events = useMemo(() => task?.executionEvents ?? [], [task]);
  const bubbles = useMemo(() => mapEventsToTeamChatBubbles(events), [events]);
  const stats = useMemo(() => summarizeA2aEvents(events), [events]);

  // 新事件到达时滚到底部（群聊观感）
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [bubbles.length, task?.workResult]);

  if (!task) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm font-medium text-foreground">任务不存在或已删除</p>
        <p className="text-xs text-muted-foreground">这个会话关联的看板任务找不到了。</p>
      </div>
    );
  }

  const statusMeta = STATUS_META[task.status];
  const agentOf = (id: string) => agents.find((a) => a.id === id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 任务头：标题 + 状态 + 统计 + 验收入口 */}
      <div className="shrink-0 border-b border-black/[0.06] px-8 py-3">
        <div className="mx-auto flex max-w-[1000px] flex-wrap items-center gap-2">
          <Users className="h-4 w-4 shrink-0" style={{ color: '#6366f1' }} />
          <span className="min-w-0 flex-1 truncate text-[14px] font-bold text-foreground">{task.title}</span>
          <span
            className="rounded-full px-2 py-0.5 text-[10.5px] font-bold"
            style={{ background: `${statusMeta.color}22`, color: statusMeta.color }}
          >
            {statusMeta.label}
          </span>
          {stats.total > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {stats.rounds || 1} 轮协作 · {stats.pass} 通过{stats.rework > 0 ? ` · ${stats.rework} 返工` : ''}
            </span>
          )}
          {task.status === 'review' && (
            <button
              type="button"
              onClick={() => navigate(`/kanban?task=${encodeURIComponent(task.id)}`)}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-black/5"
              style={{ color: '#22c55e' }}
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              去验收
            </button>
          )}
        </div>
      </div>

      {/* 群聊消息流 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-5">
        <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-4">
          {bubbles.length === 0 && (
            <p className="py-8 text-center text-[12.5px] text-muted-foreground">
              {task.status === 'todo'
                ? '任务已派发，等待编排器领取。团队成员开始协作后，过程会实时出现在这里。'
                : '还没有协作记录。'}
            </p>
          )}
          {bubbles.map((b) => {
            if (b.kind === 'system') {
              return (
                <p key={b.id} className="text-center text-[11px] text-muted-foreground">
                  {b.text}
                </p>
              );
            }
            const speaker = agentOf(b.actorId);
            const isLeader = b.actorId === leaderId;
            return (
              <div key={b.id} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-[16px]">
                  {speaker?.avatar ?? '🤖'}
                </span>
                <div className="min-w-0 max-w-[78%]">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px]">
                    <span className="font-semibold text-foreground">{speaker?.name ?? b.actorId}</span>
                    {isLeader && (
                      <span className="rounded px-1 py-px text-[9px] font-bold" style={{ background: '#FFD23333', color: '#b8860b' }}>
                        leader
                      </span>
                    )}
                    {b.round !== null && <span className="text-muted-foreground">第{b.round}轮</span>}
                    {b.verdict === 'pass' && (
                      <span className="rounded px-1 py-px text-[9px] font-bold" style={{ background: '#22c55e22', color: '#22c55e' }}>PASS</span>
                    )}
                    {b.verdict === 'rework' && (
                      <span className="rounded px-1 py-px text-[9px] font-bold" style={{ background: '#f59e0b22', color: '#f59e0b' }}>REWORK</span>
                    )}
                  </div>
                  <div className="rounded-2xl rounded-tl-md border border-black/[0.05] bg-black/[0.03] px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">
                    {b.text}
                  </div>
                </div>
              </div>
            );
          })}

          {/* 最终交付：leader 身份汇总发言，Markdown 渲染 */}
          {task.workResult && (
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#FFD233]/30 text-[16px]">
                {leaderId ? (agentOf(leaderId)?.avatar ?? '🤖') : '📦'}
              </span>
              <div className="min-w-0 max-w-[85%]">
                <div className="mb-1 flex items-center gap-1.5 text-[11px]">
                  <span className="font-semibold text-foreground">
                    {leaderId ? (agentOf(leaderId)?.name ?? leaderId) : '团队'}
                  </span>
                  <span className="rounded px-1 py-px text-[9px] font-bold" style={{ background: '#22c55e22', color: '#22c55e' }}>最终交付</span>
                </div>
                <div className="rounded-2xl rounded-tl-md border border-[#22c55e]/25 bg-[#22c55e]/[0.06] px-3.5 py-2.5">
                  <MarkdownContent content={task.workResult} className="text-[13px] leading-relaxed" />
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

export default TeamTaskChatView;
