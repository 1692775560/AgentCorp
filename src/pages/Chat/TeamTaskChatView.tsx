/**
 * src/pages/Chat/TeamTaskChatView.tsx
 * 团队任务会话视图：把看板任务的 A2A 协作过程渲染成群聊，
 * 并支持与团队直接对话——默认 leader 接话，@成员名 可点名任意成员。
 *
 * 数据来自 useApprovalsStore 的任务执行事件（autoWorker 节流写回），
 * 随任务推进实时刷新；对话通过 appendTaskExecutionEvent 以 chat: 前缀事件
 * 持久化到任务上（看板时间线同样可见，诚实留痕），回复走 runRealChat 真实模型，
 * 不经过网关消息通道。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AtSign, ClipboardCheck, Download, FolderOpen, Globe, Loader2, RotateCcw, SendHorizonal, TriangleAlert, Users } from 'lucide-react';
import { toast } from 'sonner';

import { useApprovalsStore } from '@/stores/approvals';
import { useAgentsStore } from '@/stores/agents';
import { useChatStore } from '@/stores/chat';
import { useTeamsStore } from '@/stores/teams';
import MarkdownContent from '@/pages/Chat/MarkdownContent';
import {
  acceptTaskRework,
  buildTaskIntakeMessages,
  buildTeamChatMessages,
  buildTeamChatRenderItems,
  createTaskFromChatIntake,
  isNearBottom,
  mapEventsToTeamChatBubbles,
  parseExecuteMarker,
  parseMentionTarget,
  parseTaskIntake,
  shouldShowDelivery,
  taskTitleFromInstruction,
  type TeamChatBubble,
} from '@/lib/team-task-chat';
import { retryFailedTask, runTeamChatWorkOrder } from '@/stores/teamChatWorkOrder';
import { summarizeA2aEvents } from '@/lib/a2a-timeline';
import { runRealChat } from '@/engine/llm/realExecutor';
import { invokeIpc } from '@/lib/api-client';
import { cn, isAvatarImage } from '@/lib/utils';
import type { KanbanTask } from '@/types/task';

const STATUS_META: Record<KanbanTask['status'], { label: string; color: string }> = {
  todo: { label: '待办', color: '#9ca3af' },
  'in-progress': { label: '进行中', color: '#3b82f6' },
  review: { label: '待验收', color: '#f59e0b' },
  done: { label: '已完成', color: '#22c55e' },
};

/** 头像可能是 emoji 也可能是 base64/URL 图片，按形态渲染，避免图片串当文本显示成乱码。 */
function AgentAvatar({ avatar, className }: { avatar?: string | null; className?: string }) {
  if (isAvatarImage(avatar)) {
    return <img src={avatar!} alt="" className={cn('rounded-full object-cover', className)} />;
  }
  return <span className={className}>{avatar ?? '🤖'}</span>;
}

export function TeamTaskChatView({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  const tasks = useApprovalsStore((s) => s.tasks);
  const fetchTasks = useApprovalsStore((s) => s.fetchTasks);
  const appendEvent = useApprovalsStore((s) => s.appendTaskExecutionEvent);
  const createTask = useApprovalsStore((s) => s.createTask);
  const agents = useAgentsStore((s) => s.agents);
  const teams = useTeamsStore((s) => s.teams);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 用户是否停留在底部：在底部才自动跟随新消息；上滑看历史时不拽回
  const nearBottomRef = useRef(true);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  // 交付气泡动作：ZIP 打包中状态
  const [zipping, setZipping] = useState(false);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  const task = tasks.find((t) => t.id === taskId) ?? null;
  const team = task?.teamId ? teams.find((t) => t.id === task.teamId) ?? null : null;
  const leaderId = team?.leaderId ?? task?.assigneeId ?? null;

  /** 在系统浏览器打开 HTML 交付物（无 HTML 时如实提示） */
  const handleOpenHtml = useCallback(async () => {
    if (!task) return;
    try {
      const res = await invokeIpc<{ success: boolean; error?: string }>('task:openHtmlDeliverable', { taskId: task.id });
      if (!res?.success) toast.error(res?.error || '没有可直接打开的 HTML 交付物');
    } catch (err) {
      toast.error(`打开失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [task]);

  /** 交付目录打包 ZIP 并打开所在位置 */
  const handleDownloadZip = useCallback(async () => {
    if (!task || zipping) return;
    setZipping(true);
    try {
      const res = await invokeIpc<{ success: boolean; zipPath?: string; error?: string }>('task:zipDeliverables', { taskId: task.id });
      if (res?.success && res.zipPath) {
        toast.success('ZIP 已生成');
        await invokeIpc('shell:showItemInFolder', res.zipPath).catch(() => {});
      } else {
        toast.error(res?.error || '打包失败');
      }
    } catch (err) {
      toast.error(`打包失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setZipping(false);
    }
  }, [task, zipping]);

  // 可对话成员：leader 在前，其余成员随后（@ 候选 + 默认接话人）
  const members = useMemo(() => {
    if (!team) return [];
    const ids = [team.leaderId, ...team.memberIds];
    return ids
      .map((id) => agents.find((a) => a.id === id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
  }, [team, agents]);

  const events = useMemo(() => task?.executionEvents ?? [], [task]);
  const bubbles = useMemo(() => mapEventsToTeamChatBubbles(events), [events]);
  const stats = useMemo(() => summarizeA2aEvents(events), [events]);
  // 对话历史（chat: 事件映射出的用户/成员气泡），供组装多轮上下文
  const chatHistory = useMemo(
    () => bubbles.filter((b) => b.kind === 'user' || (b.kind === 'a2a' && b.peerId === 'user')),
    [bubbles],
  );
  // 执行中（含返工重做）时旧交付物视为过期：不展示，避免「刚开始重做就看到上一版交付」
  const isWorking = task?.workState === 'working' || task?.workState === 'starting';
  const hasDelivery = shouldShowDelivery(task?.workResult, task?.workState);
  // 渲染序列：「最终交付」按时间序插在协作过程末尾、后续对话之前
  const renderItems = useMemo(
    () => buildTeamChatRenderItems(bubbles, hasDelivery),
    [bubbles, hasDelivery],
  );

  // 新消息到达时：仅当用户本来就在底部附近才自动滚底（上滑看历史不打断）
  useEffect(() => {
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [renderItems.length, task?.workResult]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
  }, []);

  // @ 提及候选：输入尾部出现 @xxx 时弹出成员列表
  const mentionQuery = useMemo(() => {
    const m = /(?:^|\s)@([^\s@]*)$/.exec(draft);
    return m ? m[1] : null;
  }, [draft]);
  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    return members.filter((a) => a.name.toLowerCase().includes(mentionQuery.toLowerCase()));
  }, [members, mentionQuery]);

  useEffect(() => {
    setMentionOpen(mentionQuery !== null && mentionCandidates.length > 0);
  }, [mentionQuery, mentionCandidates.length]);

  const applyMention = useCallback(
    (name: string) => {
      setDraft((prev) => prev.replace(/(?:^|\s)@([^\s@]*)$/, (s) => `${s.startsWith(' ') ? ' ' : ''}@${name} `));
      setMentionOpen(false);
      inputRef.current?.focus();
    },
    [],
  );

  /** 失败自救：与看板/房间共用 teamChatWorkOrder 的 retryFailedTask，重新排队待 AutoWorker 重领 */
  const handleRetryFailed = useCallback(async () => {
    if (!task) return;
    try {
      const ok = await retryFailedTask(task.id);
      if (ok) toast.info('已重新排队，AutoWorker 会重新领取执行');
      else toast.error('重试未受理：任务不在失败态或正在执行中');
    } catch (err) {
      toast.error(`重试失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [task]);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending || !task) return;
    const mention = parseMentionTarget(text, members.map((a) => ({ id: a.id, name: a.name })));
    const targetId = mention?.targetId ?? leaderId;
    const target = agents.find((a) => a.id === targetId);
    if (!targetId || !target) {
      toast.error('团队还没有可接话的成员，请先检查团队配置');
      return;
    }
    const userText = mention?.cleanText || text;

    setSending(true);
    setDraft('');
    setMentionOpen(false);
    // 自己发消息时视为回到底部，允许后续自动跟随
    nearBottomRef.current = true;
    try {
      // 1) 用户发言落事件（右列气泡 + 看板留痕）
      await appendEvent(task.id, { type: `chat:user→${targetId}`, content: text });
      // 2) 组上下文调真实模型，拿成员回复
      const messages = buildTeamChatMessages(
        {
          id: target.id,
          name: target.name,
          persona: target.persona,
          responsibility: target.responsibility,
          isLeader: targetId === leaderId,
        },
        {
          taskTitle: task.title,
          taskDescription: task.description,
          teamName: team?.name ?? task.teamName,
          workResultExcerpt: task.workResult ? task.workResult.slice(0, 800) : undefined,
          deliveryReady: Boolean(task.deliverableDir),
        },
        chatHistory,
        userText,
      );
      const reply = await runRealChat(messages);
      // 3) 成员回复落事件（左列气泡）；leader 回复里的 [EXECUTE] 标记剥离后展示
      const { text: replyText, execute } = parseExecuteMarker(reply);
      await appendEvent(task.id, { type: `chat:${targetId}→user`, content: replyText });
      // 4) leader 判定为派活 → 触发真实编排。三路意图：REWORK 改当前任务 /
      //    NEW 立新任务（过程在新任务会话展开）/ CHAT 不动手。
      //    intake 一次调用完成分类与需求归纳；[EXECUTE] 标记视作 REWORK。
      if (targetId === leaderId) {
        let intake = null;
        try {
          intake = parseTaskIntake(await runRealChat(buildTaskIntakeMessages(userText, chatHistory, true), 900));
        } catch {
          /* intake 失败则保守不执行 */
        }
        const intent = execute ? 'rework' : (intake?.intent ?? 'chat');
        if (intent === 'rework') {
          // 受理成功才提示「开始执行」；任务被占用时提示稍后再试，不先报喜
          await acceptTaskRework(task.id, userText, { runWorkOrder: runTeamChatWorkOrder, toast });
        } else if (intent === 'new' && task.teamId) {
          // intake 已按对话上下文归纳标题与需求；缺失时回退原文（原行为）。
          // 知会消息 best-effort：执行触发不依赖它（append 抛错不能卡住派活）。
          await createTaskFromChatIntake(
            {
              taskId: task.id,
              teamId: task.teamId,
              teamName: team?.name ?? task.teamName ?? '',
              leaderId: targetId,
            },
            {
              title: intake?.title ?? taskTitleFromInstruction(userText),
              requirement: intake?.requirement ?? userText,
            },
            userText,
            {
              createTask,
              ensureTeamTaskSession: (t) => useChatStore.getState().ensureTeamTaskSession(t),
              appendTaskEvent: appendEvent,
              runWorkOrder: runTeamChatWorkOrder,
              toast,
            },
          );
        }
      }
    } catch (err) {
      toast.error(`发送失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  }, [agents, appendEvent, chatHistory, createTask, draft, leaderId, members, sending, task, team]);

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
  const mentionTargetName = (b: TeamChatBubble) => agentOf(b.peerId)?.name ?? null;
  /** actorId 可能指向团队（编排器以团队身份发的事件，映射层已剥 team: 前缀），回退显示团队名而不是原始 ID */
  const speakerName = (id: string) => {
    const agent = agentOf(id);
    if (agent) return agent.name;
    const ownerTeam = teams.find((t) => t.id === id || `team:${t.id}` === id);
    if (ownerTeam) return ownerTeam.name;
    if (id.startsWith('team:')) return team?.name ?? '团队';
    return id;
  };

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

      {/* 执行中指示：任务在跑时常驻显示最新动作，会话里随时可见「正在干嘛」 */}
      {(task.status === 'in-progress' || task.workState === 'working') && (
        <div className="shrink-0 border-b border-black/[0.06] px-8 py-2" style={{ background: '#3b82f608' }}>
          <div className="mx-auto flex max-w-[1000px] items-center gap-2 text-[12px]" style={{ color: '#3b82f6' }}>
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            <span className="font-semibold">团队正在干活</span>
            {events.length > 0 && (
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                最新：{events[events.length - 1].content ?? '执行中…'}
              </span>
            )}
          </div>
        </div>
      )}

      {/* 失败自救条：任务执行失败时给出原因 + 一键重试（重新排队待 AutoWorker 重领） */}
      {task.workState === 'failed' && (
        <div className="shrink-0 border-b border-black/[0.06] px-8 py-2" style={{ background: '#ef444408' }}>
          <div className="mx-auto flex max-w-[1000px] items-center gap-2 text-[12px]" style={{ color: '#ef4444' }}>
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            <span className="shrink-0 font-semibold">执行失败</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{task.workError ?? '未知错误'}</span>
            <button
              type="button"
              onClick={() => void handleRetryFailed()}
              className="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-black/5"
              style={{ color: '#ef4444' }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              重试
            </button>
          </div>
        </div>
      )}

      {/* 群聊消息流 */}
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto px-8 py-5">
        <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-4">
          {renderItems.length === 0 && (
            <p className="py-8 text-center text-[12.5px] text-muted-foreground">
              {task.status === 'todo'
                ? '任务已派发，等待编排器领取。你可以先在下面和团队 leader 聊聊需求。'
                : '还没有协作记录。'}
            </p>
          )}
          {renderItems.map((item) => {
            // 最终交付气泡：按时间序内联在协作过程末尾，不再钉死在流底
            if (item.delivery) {
              return (
                <div key={item.key} className="flex items-start gap-2.5">
                  <AgentAvatar
                    avatar={leaderId ? (agentOf(leaderId)?.avatar ?? null) : '📦'}
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#FFD233]/30 text-[16px]"
                  />
                  <div className="min-w-0 max-w-[85%]">
                    <div className="mb-1 flex items-center gap-1.5 text-[11px]">
                      <span className="font-semibold text-foreground">
                        {leaderId ? speakerName(leaderId) : '团队'}
                      </span>
                      <span className="rounded px-1 py-px text-[9px] font-bold" style={{ background: '#22c55e22', color: '#22c55e' }}>最终交付</span>
                    </div>
                    <div className="rounded-2xl rounded-tl-md border border-[#22c55e]/25 bg-[#22c55e]/[0.06] px-3.5 py-2.5">
                      <MarkdownContent content={task.workResult!} className="text-[13px] leading-relaxed" />
                    </div>
                    {task.deliverableDir && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleOpenHtml()}
                          className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-black/5"
                          style={{ color: '#f59e0b' }}
                        >
                          <Globe className="h-3.5 w-3.5" />
                          在浏览器打开
                        </button>
                        <button
                          type="button"
                          onClick={() => void invokeIpc('shell:openPath', task.deliverableDir)}
                          className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-black/5"
                          style={{ color: '#22c55e' }}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                          打开交付目录
                        </button>
                        <button
                          type="button"
                          disabled={zipping}
                          onClick={() => void handleDownloadZip()}
                          className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-black/5 disabled:opacity-50"
                          style={{ color: '#6366f1' }}
                        >
                          <Download className="h-3.5 w-3.5" />
                          {zipping ? '打包中…' : '下载 ZIP'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            const b = item.bubble!;
            if (b.kind === 'system') {
              return (
                <p key={item.key} className="text-center text-[11px] text-muted-foreground">
                  {b.text}
                </p>
              );
            }
            if (b.kind === 'user') {
              const toName = mentionTargetName(b);
              return (
                <div key={item.key} className="flex items-start justify-end gap-2.5">
                  <div className="min-w-0 max-w-[78%]">
                    <div className="mb-1 flex items-center justify-end gap-1.5 text-[11px]">
                      <span className="text-muted-foreground">你{toName ? ` → ${toName}` : ''}</span>
                    </div>
                    <div className="rounded-2xl rounded-tr-md px-3.5 py-2.5 text-[13px] leading-relaxed text-white" style={{ background: '#6366f1' }}>
                      {b.text}
                    </div>
                  </div>
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[16px]" style={{ background: '#6366f122' }}>
                    👤
                  </span>
                </div>
              );
            }
            const speaker = agentOf(b.actorId);
            const isLeader = b.actorId === leaderId;
            return (
              <div key={item.key} className="flex items-start gap-2.5">
                <AgentAvatar
                  avatar={speaker?.avatar}
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-[16px]"
                />
                <div className="min-w-0 max-w-[78%]">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px]">
                    <span className="font-semibold text-foreground">{speakerName(b.actorId)}</span>
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
                    {b.peerId === 'user' ? (
                      <MarkdownContent content={b.text} className="text-[13px] leading-relaxed" />
                    ) : (
                      b.text
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {sending && (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              成员正在回复…
            </div>
          )}
          {isWorking && (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: '#6366f1' }} />
              团队正在{task.workResult ? '按你的反馈重做' : '执行'}中，最新动态见上方协作记录…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* 对话输入：默认 leader 接话，@ 可点名任意成员 */}
      <div className="shrink-0 border-t border-black/[0.06] px-8 py-3">
        <div className="relative mx-auto max-w-[1000px]">
          {mentionOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-[220px] overflow-hidden rounded-xl border border-black/[0.08] bg-white shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
              {mentionCandidates.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => applyMention(a.name)}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-[#f2f2f7]"
                >
                  <AgentAvatar
                    avatar={a.avatar}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-[13px]"
                  />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  {a.id === leaderId && (
                    <span className="shrink-0 rounded px-1 py-px text-[9px] font-bold" style={{ background: '#FFD23333', color: '#b8860b' }}>leader</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2 rounded-2xl border border-black/[0.08] bg-white px-3.5 py-2.5">
            <AtSign
              className="mb-1 h-4 w-4 shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                setDraft((prev) => `${prev}${prev.endsWith(' ') || prev === '' ? '' : ' '}@`);
                inputRef.current?.focus();
              }}
            />
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !mentionOpen) {
                  // 中文输入法组词中的 Enter 是选词，不发送（与 ChatInput 同款守卫）
                  const nativeEvent = e.nativeEvent as KeyboardEvent;
                  if (nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
                  e.preventDefault();
                  void handleSend();
                }
              }}
              rows={1}
              disabled={sending}
              placeholder={
                leaderId
                  ? `和团队聊聊…（默认 ${agentOf(leaderId)?.name ?? 'leader'} 接话，@ 可点名成员）`
                  : '和团队聊聊…'
              }
              className={cn(
                'max-h-32 min-h-[22px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed outline-none',
                'placeholder:text-muted-foreground/70 disabled:opacity-60',
              )}
            />
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={sending || !draft.trim()}
              className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white transition-opacity disabled:opacity-40"
              style={{ background: '#6366f1' }}
              aria-label="发送"
            >
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SendHorizonal className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TeamTaskChatView;
