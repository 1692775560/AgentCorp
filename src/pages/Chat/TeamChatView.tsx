/**
 * src/pages/Chat/TeamChatView.tsx
 * 团队房间：与整个团队对话的会话视图——默认 leader 接话，@成员名 点名任意成员。
 *
 * 与 TeamTaskChatView（单任务）的区别：这里是团队级常驻房间，
 * 聊天记录挂在团队对象上（team.chatEvents，上限 200 条），刷新/重启不丢。
 * 在房间里派活会自动立项：创建看板团队任务并触发真实编排，
 * 执行过程在对应的任务会话里展开。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AtSign, CheckCircle2, ClipboardList, Loader2, MessageCircle, RotateCcw, SendHorizonal, TriangleAlert, Users } from 'lucide-react';
import { toast } from 'sonner';

import { useAgentsStore } from '@/stores/agents';
import { useApprovalsStore } from '@/stores/approvals';
import { useChatStore } from '@/stores/chat';
import { useTeamsStore } from '@/stores/teams';
import MarkdownContent from '@/pages/Chat/MarkdownContent';
import {
  buildDirectAssignInstruction,
  buildTaskDraftMessages,
  buildTeamChatMessages,
  buildWorkIntentClassifierMessages,
  findReviewTaskForDelivery,
  isNearBottom,
  mapTeamChatEventsToBubbles,
  parseDirectAssignTarget,
  parseExecuteMarker,
  parseMentionTarget,
  parseTaskDraft,
  parseWorkIntent,
  taskTitleFromInstruction,
  type TeamChatBubble,
} from '@/lib/team-task-chat';
import { retryFailedTask, runTeamChatWorkOrder } from '@/stores/teamChatWorkOrder';
import { runRealChat } from '@/engine/llm/realExecutor';
import { cn, isAvatarImage } from '@/lib/utils';
import type { KanbanTask } from '@/types/task';

/** 头像可能是 emoji 也可能是 base64/URL 图片，按形态渲染。 */
function AgentAvatar({ avatar, className }: { avatar?: string | null; className?: string }) {
  if (isAvatarImage(avatar)) {
    return <img src={avatar!} alt="" className={cn('rounded-full object-cover', className)} />;
  }
  return <span className={className}>{avatar ?? '🤖'}</span>;
}

export function TeamChatView({ teamId }: { teamId: string }) {
  const navigate = useNavigate();
  const teams = useTeamsStore((s) => s.teams);
  const fetchTeams = useTeamsStore((s) => s.fetchTeams);
  const agents = useAgentsStore((s) => s.agents);
  const tasks = useApprovalsStore((s) => s.tasks);
  const createTask = useApprovalsStore((s) => s.createTask);
  const updateTask = useApprovalsStore((s) => s.updateTask);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  // 房间内一键验收/打回：reviewBusy 防连点；rejectTaskId 记录正在填打回意见的任务
  const [reviewBusy, setReviewBusy] = useState(false);
  const [rejectTaskId, setRejectTaskId] = useState<string | null>(null);
  const [rejectDraft, setRejectDraft] = useState('');

  useEffect(() => {
    void fetchTeams();
  }, [fetchTeams]);

  const team = teams.find((t) => t.id === teamId) ?? null;
  const leaderId = team?.leaderId ?? null;
  const teamTasks = useMemo(() => tasks.filter((t) => t.teamId === teamId), [tasks, teamId]);

  // 可对话成员：leader 在前
  const members = useMemo(() => {
    if (!team) return [];
    const ids = [team.leaderId, ...team.memberIds];
    return ids
      .map((id) => agents.find((a) => a.id === id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
  }, [team, agents]);

  const bubbles = useMemo(
    () => mapTeamChatEventsToBubbles(team?.chatEvents ?? []),
    [team?.chatEvents],
  );

  // 失败自救：本团队失败态任务，房间顶部出失败条 + 重试入口
  const failedTasks = useMemo(
    () => teamTasks.filter((t) => t.workState === 'failed'),
    [teamTasks],
  );

  // 交付消息 → 可验收任务（按「标题」唯一匹配 review 任务；同一任务只把按钮挂在最新一条交付气泡上，
  // 返工循环里的历史交付消息不再重复出现按钮）
  const reviewActionByBubble = useMemo(() => {
    const latestBubbleByTask = new Map<string, string>();
    for (const b of bubbles) {
      if (b.kind === 'user') continue;
      const t = findReviewTaskForDelivery(b.text, teamTasks);
      if (t) latestBubbleByTask.set(t.id, b.id);
    }
    const byBubble = new Map<string, KanbanTask>();
    for (const [taskId, bubbleId] of latestBubbleByTask) {
      const t = teamTasks.find((x) => x.id === taskId);
      if (t) byBubble.set(bubbleId, t);
    }
    return byBubble;
  }, [bubbles, teamTasks]);

  useEffect(() => {
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [bubbles.length]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
  }, []);

  // @ 提及候选
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

  const applyMention = useCallback((name: string) => {
    setDraft((prev) => prev.replace(/(?:^|\s)@([^\s@]*)$/, (s) => `${s.startsWith(' ') ? ' ' : ''}@${name} `));
    setMentionOpen(false);
    inputRef.current?.focus();
  }, []);

  /** 追加一条房间消息（走 teams store，基于最新状态 + 200 条封顶） */
  const appendRoomEvent = useTeamsStore((s) => s.appendTeamChatEvent);

  /** 失败自救：房间失败条/任务会话失败条共用 teamChatWorkOrder 的 retryFailedTask */
  const handleRetryFailed = useCallback(async (taskId: string) => {
    try {
      const ok = await retryFailedTask(taskId);
      if (ok) toast.info('已重新排队，AutoWorker 会重新领取执行');
      else toast.error('重试未受理：任务不在失败态或正在执行中');
    } catch (err) {
      toast.error(`重试失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  /** 房间内一键验收：任务转 done + 房间留一条「老板已验收」 */
  const handleAcceptDelivery = useCallback(
    async (task: KanbanTask) => {
      if (reviewBusy || !team) return;
      setReviewBusy(true);
      try {
        await updateTask(task.id, { status: 'done' });
        await appendRoomEvent(teamId, {
          from: 'user',
          to: team.leaderId,
          content: `✅ 已验收「${task.title}」，这版通过，辛苦了！`,
        });
        toast.success(`已验收「${task.title}」`);
      } catch (err) {
        toast.error(`验收失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setReviewBusy(false);
      }
    },
    [appendRoomEvent, reviewBusy, team, teamId, updateTask],
  );

  /** 房间内打回重做：填意见 → 回 in-progress + 复用编排管线重跑 */
  const handleRejectDelivery = useCallback(
    async (task: KanbanTask) => {
      const feedback = rejectDraft.trim();
      if (!feedback || reviewBusy || !team) return;
      setReviewBusy(true);
      try {
        await appendRoomEvent(teamId, {
          from: 'user',
          to: team.leaderId,
          content: `🔁 「${task.title}」打回重做：${feedback}`,
        });
        await updateTask(task.id, { status: 'in-progress' });
        setRejectTaskId(null);
        setRejectDraft('');
        toast.info('已打回，leader 重新拆解分派中');
        void runTeamChatWorkOrder(task.id, `打回重做：${feedback}`).catch((err) => {
          toast.error(`打回重做执行失败：${err instanceof Error ? err.message : String(err)}`);
        });
      } catch (err) {
        toast.error(`打回失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setReviewBusy(false);
      }
    },
    [appendRoomEvent, rejectDraft, reviewBusy, team, teamId, updateTask],
  );

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending || !team) return;
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
    nearBottomRef.current = true;
    try {
      // 1) 老板发言落房间
      await appendRoomEvent(teamId, { from: 'user', to: targetId, content: text });
      // 1.5) @非 leader 成员且语义是派活 → 直派：立项并把 assignee 指到该成员，
      //      编排指令加「【指定执行：@成员】」前缀让 leader 拆解时带上指定人；
      //      leader 模板知会（快且确定）。闲聊则维持原成员对话路径。
      const directAssign = parseDirectAssignTarget(
        text,
        members.map((a) => ({ id: a.id, name: a.name })),
        leaderId,
      );
      if (directAssign) {
        let isWork = false;
        try {
          const verdict = await runRealChat(buildWorkIntentClassifierMessages(directAssign.instruction, false), 8);
          isWork = parseWorkIntent(verdict) !== 'chat';
        } catch {
          /* 分类器失败按闲聊处理，不擅自立项 */
        }
        if (isWork) {
          const created = await createTask({
            title: taskTitleFromInstruction(directAssign.instruction),
            description: directAssign.instruction,
            priority: 'medium',
            teamId: team.id,
            teamName: team.name,
            assigneeId: directAssign.targetId,
            assigneeRole: directAssign.targetName,
          });
          useChatStore.getState().ensureTeamTaskSession({
            id: created.id,
            title: created.title,
            teamId: team.id,
            teamName: team.name,
          });
          if (leaderId) {
            await appendRoomEvent(teamId, {
              from: leaderId,
              to: 'user',
              content: `收到，已直接指派给 @${directAssign.targetName}：「${created.title}」，我盯进度，执行过程在任务会话里同步。`,
            });
          }
          toast.info(`已立项「${created.title}」并直接指派给 ${directAssign.targetName}`);
          void runTeamChatWorkOrder(
            created.id,
            buildDirectAssignInstruction(directAssign.targetName, directAssign.instruction),
          ).catch((err) => {
            toast.error(`派活执行失败：${err instanceof Error ? err.message : String(err)}`);
          });
          return;
        }
      }
      // 2) 组上下文调真实模型
      const history = mapTeamChatEventsToBubbles(
        useTeamsStore.getState().teams.find((t) => t.id === teamId)?.chatEvents ?? [],
      );
      const messages = buildTeamChatMessages(
        {
          id: target.id,
          name: target.name,
          persona: target.persona,
          responsibility: target.responsibility,
          isLeader: targetId === leaderId,
        },
        { teamName: team.name },
        history.slice(0, -1), // 去掉刚写入的这条，作为最后一条 user 消息传入
        userText,
      );
      const reply = await runRealChat(messages);
      const { text: replyText, execute } = parseExecuteMarker(reply);
      await appendRoomEvent(teamId, { from: targetId, to: 'user', content: replyText });

      // 3) 对 leader 派活 → 立项 + 真实编排（过程在任务会话里展开）。
      //    房间里没有「当前任务」，REWORK 视同 NEW（立新项）。
      if (targetId === leaderId) {
        let shouldExecute = execute;
        if (!shouldExecute) {
          try {
            const verdict = await runRealChat(buildWorkIntentClassifierMessages(userText, false), 8);
            shouldExecute = parseWorkIntent(verdict) !== 'chat';
          } catch {
            /* 分类器失败则保守不执行 */
          }
        }
        if (shouldExecute) {
          // 立项前先按对话上下文草拟标题与需求描述：「开工吧」这类指代性
          // 指令的真实需求在上下文里，只拿最后一句话立项会让 leader 在
          // 真空中编造项目。草稿调用失败回退为原文立项（原行为）。
          let draftTitle = taskTitleFromInstruction(userText);
          let draftRequirement = userText;
          try {
            const draftRaw = await runRealChat(buildTaskDraftMessages(userText, history), 800);
            const draft = parseTaskDraft(draftRaw);
            if (draft) {
              draftTitle = draft.title;
              draftRequirement = draft.requirement;
            }
          } catch {
            /* 需求草稿失败回退原文立项 */
          }
          const created = await createTask({
            title: draftTitle,
            description: draftRequirement,
            priority: 'medium',
            teamId: team.id,
            teamName: team.name,
          });
          useChatStore.getState().ensureTeamTaskSession({
            id: created.id,
            title: created.title,
            teamId: team.id,
            teamName: team.name,
          });
          await appendRoomEvent(teamId, {
            from: targetId,
            to: 'user',
            content: `已立项「${created.title}」，我这就拆解分派，执行过程在任务会话里同步。`,
          });
          toast.info('已创建团队任务并开始执行，过程可在任务会话中查看');
          void runTeamChatWorkOrder(created.id, userText).catch((err) => {
            toast.error(`派活执行失败：${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }
    } catch (err) {
      toast.error(`发送失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  }, [agents, appendRoomEvent, createTask, draft, leaderId, members, sending, team, teamId]);

  if (!team) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm font-medium text-foreground">团队不存在或已解散</p>
        <p className="text-xs text-muted-foreground">这个房间关联的团队找不到了。</p>
      </div>
    );
  }

  const agentOf = (id: string) => agents.find((a) => a.id === id);
  const mentionTargetName = (b: TeamChatBubble) => agentOf(b.peerId)?.name ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 团队头：名称 + 成员 + 任务入口 */}
      <div className="shrink-0 border-b border-black/[0.06] px-8 py-3">
        <div className="mx-auto flex max-w-[1000px] flex-wrap items-center gap-2">
          <Users className="h-4 w-4 shrink-0" style={{ color: '#6366f1' }} />
          <span className="min-w-0 flex-1 truncate text-[14px] font-bold text-foreground">{team.name}</span>
          <span className="text-[11px] text-muted-foreground">{members.length} 名成员</span>
          {teamTasks.length > 0 && (
            <button
              type="button"
              onClick={() => navigate('/kanban')}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-black/5"
              style={{ color: '#6366f1' }}
            >
              <ClipboardList className="h-3.5 w-3.5" />
              {teamTasks.length} 个任务
            </button>
          )}
        </div>
        {/* 成员行：点头像旁按钮私聊 */}
        <div className="mx-auto mt-2 flex max-w-[1000px] flex-wrap items-center gap-1.5">
          {members.map((a) => (
            <span
              key={a.id}
              className="flex items-center gap-1.5 rounded-full bg-black/[0.03] px-2 py-1 text-[11px] font-semibold"
            >
              <AgentAvatar avatar={a.avatar} className="flex h-4 w-4 items-center justify-center rounded-full text-[11px]" />
              <span className="max-w-[90px] truncate">{a.name}</span>
              {a.id === leaderId && (
                <span className="rounded px-1 py-px text-[9px] font-bold" style={{ background: '#FFD23333', color: '#b8860b' }}>leader</span>
              )}
              <button
                type="button"
                title={`私聊 ${a.name}`}
                onClick={() => {
                  try {
                    useChatStore.getState().openDirectAgentSession(a.id, {
                      teamId: team.id,
                      teamName: team.name,
                      isLeaderChat: a.id === leaderId,
                    });
                  } catch {
                    /* agent 不存在时忽略 */
                  }
                }}
                className="flex items-center justify-center rounded-full p-0.5 transition-colors hover:bg-white"
                style={{ color: '#6366f1' }}
              >
                <MessageCircle className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* 失败自救条：本团队有失败任务时置顶提示，一键重新排队（AutoWorker 重领） */}
      {failedTasks.length > 0 && (
        <div className="shrink-0 border-b border-black/[0.06] px-8 py-2" style={{ background: '#ef444408' }}>
          <div className="mx-auto flex max-w-[1000px] flex-col gap-1.5">
            {failedTasks.map((t) => (
              <div key={t.id} className="flex items-center gap-2 text-[12px]" style={{ color: '#ef4444' }}>
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                <span className="font-semibold">「{t.title}」执行失败</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{t.workError ?? ''}</span>
                <button
                  type="button"
                  onClick={() => void handleRetryFailed(t.id)}
                  className="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-black/5"
                  style={{ color: '#ef4444' }}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  重试
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 房间消息流 */}
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto px-8 py-5">
        <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-4">
          {bubbles.length === 0 && (
            <p className="py-8 text-center text-[12.5px] text-muted-foreground">
              这是 {team.name} 的房间。直接说话默认 {agentOf(team.leaderId)?.name ?? 'leader'} 接话，
              @ 可点名成员；派活会自动立项成看板任务并真正执行。
            </p>
          )}
          {bubbles.map((b) => {
            if (b.kind === 'user') {
              const toName = mentionTargetName(b);
              return (
                <div key={b.id} className="flex items-start justify-end gap-2.5">
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
            // 交付消息关联到唯一 review 任务才挂验收/打回按钮（多义或已处理不显示）
            const reviewTask = reviewActionByBubble.get(b.id) ?? null;
            return (
              <div key={b.id} className="flex items-start gap-2.5">
                <AgentAvatar
                  avatar={speaker?.avatar}
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-[16px]"
                />
                <div className="min-w-0 max-w-[78%]">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px]">
                    <span className="font-semibold text-foreground">{speaker?.name ?? b.actorId}</span>
                    {isLeader && (
                      <span className="rounded px-1 py-px text-[9px] font-bold" style={{ background: '#FFD23333', color: '#b8860b' }}>leader</span>
                    )}
                  </div>
                  <div className="rounded-2xl rounded-tl-md border border-black/[0.05] bg-black/[0.03] px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">
                    <MarkdownContent content={b.text} className="text-[13px] leading-relaxed" />
                  </div>
                  {reviewTask && (
                    <div className="mt-1.5 flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={reviewBusy}
                          onClick={() => void handleAcceptDelivery(reviewTask)}
                          className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-black/5 disabled:opacity-50"
                          style={{ color: '#22c55e' }}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          验收
                        </button>
                        <button
                          type="button"
                          disabled={reviewBusy}
                          onClick={() => {
                            setRejectTaskId(rejectTaskId === reviewTask.id ? null : reviewTask.id);
                            setRejectDraft('');
                          }}
                          className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-black/5 disabled:opacity-50"
                          style={{ color: '#ef4444' }}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          打回重做
                        </button>
                      </div>
                      {rejectTaskId === reviewTask.id && (
                        <div className="flex items-center gap-2">
                          <input
                            value={rejectDraft}
                            onChange={(e) => setRejectDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                const nativeEvent = e.nativeEvent as KeyboardEvent;
                                if (nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
                                e.preventDefault();
                                void handleRejectDelivery(reviewTask);
                              }
                            }}
                            placeholder="打回意见：哪里不行、要怎么改…"
                            className="min-w-0 flex-1 rounded-lg border border-black/[0.08] bg-white px-2.5 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground/70"
                          />
                          <button
                            type="button"
                            disabled={reviewBusy || !rejectDraft.trim()}
                            onClick={() => void handleRejectDelivery(reviewTask)}
                            className="shrink-0 rounded-lg px-2.5 py-1.5 text-[11.5px] font-semibold text-white transition-opacity disabled:opacity-40"
                            style={{ background: '#ef4444' }}
                          >
                            确认打回
                          </button>
                        </div>
                      )}
                    </div>
                  )}
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
                  <AgentAvatar avatar={a.avatar} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-[13px]" />
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
              placeholder={`和 ${team.name} 聊聊…（默认 ${agentOf(team.leaderId)?.name ?? 'leader'} 接话，@ 可点名成员，派活会自动立项执行）`}
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

export default TeamChatView;
