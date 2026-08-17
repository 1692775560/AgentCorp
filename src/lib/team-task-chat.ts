/**
 * src/lib/team-task-chat.ts
 * 团队任务会话视图的气泡映射（纯函数）。
 *
 * 把任务的 executionEvents（含 A2A trace 事件）映射成群聊风格气泡：
 * 每条 A2A 事件 = delegatee 的一条发言（谁产出谁说话，箭头方向语义
 * 「delegator → delegatee」表示 delegatee 在干活/回话）；
 * 非 A2A 事件 = 居中系统提示行。
 */
import type { TaskExecutionEvent } from '@/types/task';
import { parseA2aRoute } from '@/lib/a2a-timeline';

export interface TeamChatBubble {
  id: string;
  kind: 'a2a' | 'system' | 'user';
  /** 发言者 agentId（system 气泡为空；user 气泡固定为 'user'） */
  actorId: string;
  /** 协作对端（审阅时是 leader，执行时是 leader；供「回复给谁」展示） */
  peerId: string;
  text: string;
  round: number | null;
  verdict: 'pass' | 'rework' | null;
  createdAt?: string;
}

/** 对话事件前缀：chat:user→<agentId>（用户发言）/ chat:<agentId>→user（成员回复）。 */
export const TEAM_CHAT_EVENT_PREFIX = 'chat:';

export function parseTeamChatRoute(type: string | undefined): { from: string; to: string } | null {
  if (!type || !type.startsWith(TEAM_CHAT_EVENT_PREFIX)) return null;
  const route = type.slice(TEAM_CHAT_EVENT_PREFIX.length);
  const sep = route.indexOf('→');
  if (sep === -1) return null;
  return { from: route.slice(0, sep).trim(), to: route.slice(sep + 1).trim() };
}

export function mapEventsToTeamChatBubbles(events: TaskExecutionEvent[]): TeamChatBubble[] {
  return events.map((e, i) => {
    const chatRoute = parseTeamChatRoute(e.type);
    if (chatRoute) {
      // 用户发言：右列气泡；成员回复：左列成员气泡（谁说话谁是 actor）。
      const isUserSpeaking = chatRoute.from === 'user';
      return {
        id: `chat-${i}`,
        kind: isUserSpeaking ? 'user' : 'a2a',
        actorId: isUserSpeaking ? 'user' : chatRoute.from,
        peerId: isUserSpeaking ? chatRoute.to : 'user',
        text: e.content ?? '',
        round: null,
        verdict: null,
        createdAt: e.createdAt,
      };
    }
    const route = parseA2aRoute(e.type);
    if (!route) {
      return {
        id: `sys-${i}`,
        kind: 'system',
        actorId: '',
        peerId: '',
        text: e.content ?? '',
        round: null,
        verdict: null,
        createdAt: e.createdAt,
      };
    }
    const roundMatch = /【第(\d+)轮】/.exec(e.content ?? '');
    const verdict = e.content?.includes('PASS')
      ? ('pass' as const)
      : e.content?.includes('REWORK')
        ? ('rework' as const)
        : null;
    return {
      id: `a2a-${i}`,
      kind: 'a2a',
      // 发言者 = 箭头终点（delegator 分派时 leader 在说话；交付/审阅时成员在说话）。
      // 这里以「动作接收方」为发言者更贴近群聊观感：事件描述的是 to 一侧的动作结果。
      actorId: route.to || route.from,
      peerId: route.to ? route.from : '',
      text: (e.content ?? '').replace(/【第\d+轮】/, '').trim(),
      round: roundMatch ? Number(roundMatch[1]) : null,
      verdict,
      createdAt: e.createdAt,
    };
  });
}

/**
 * 解析用户输入里的 @ 提及。命中成员名（@名字 或 @名字 出现在文中）即返回该成员，
 * 并给出去掉提及后的正文；未命中返回 null（调用方默认发给 leader）。
 */
export function parseMentionTarget(
  text: string,
  members: Array<{ id: string; name: string }>,
): { targetId: string; cleanText: string } | null {
  for (const m of members) {
    const token = `@${m.name}`;
    if (!text.includes(token)) continue;
    return { targetId: m.id, cleanText: text.replace(token, ' ').replace(/\s{2,}/g, ' ').trim() };
  }
  return null;
}

export interface TeamChatContext {
  taskTitle: string;
  taskDescription?: string;
  teamName?: string;
  /** 最近交付摘要（截断后注入，帮成员对齐上下文） */
  workResultExcerpt?: string;
}

/**
 * 构建发给真实模型的多轮消息：system 立人设 + 任务背景，
 * 历史只取 chat: 对话事件（协作 trace 不混入，避免上下文爆炸）。
 */
export function buildTeamChatMessages(
  agent: { id: string; name: string; persona?: string; responsibility?: string; isLeader: boolean },
  ctx: TeamChatContext,
  history: TeamChatBubble[],
  userText: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const systemParts = [
    `你是团队${ctx.teamName ? `「${ctx.teamName}」` : ''}的${agent.isLeader ? '负责人（leader）' : '成员'}「${agent.name}」。`,
    agent.persona ? `人设：${agent.persona}` : '',
    agent.responsibility ? `职责：${agent.responsibility}` : '',
    `你正在和老板就团队任务「${ctx.taskTitle}」直接沟通。`,
    ctx.taskDescription ? `任务要求：${ctx.taskDescription}` : '',
    ctx.workResultExcerpt ? `当前交付进展摘要：${ctx.workResultExcerpt}` : '',
    '回复要求：中文、口语化、简明扼要，像同事在群里回话，不要堆砌格式。',
    // 派活判定约定：leader 识别到工作指令时输出执行标记，前端据此触发真实编排
    agent.isLeader
      ? '另外：如果老板这条消息是在派活、提修改意见或追加需求（而不是闲聊、问进度或纯讨论），' +
        '先在正文里用一两句话说明你的安排，然后在回复最后另起一行只输出 [EXECUTE]；' +
        '如果只是聊天、答疑或汇报，绝对不要输出该标记。'
      : '',
  ].filter(Boolean);

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemParts.join('\n') },
  ];
  for (const b of history) {
    if (b.kind === 'user') {
      // 发给其他成员的话标注对象，避免当前成员误以为在问自己
      const toOther = b.peerId && b.peerId !== agent.id;
      messages.push({ role: 'user', content: toOther ? `（对另一位成员说）${b.text}` : b.text });
    } else if (b.kind === 'a2a' && b.peerId === 'user' && b.actorId === agent.id) {
      // 只有自己说过的话算 assistant；其他成员的回复不混入，保持人设单一
      messages.push({ role: 'assistant', content: b.text });
    }
  }
  messages.push({ role: 'user', content: userText });
  return messages;
}

export interface TeamChatRenderItem {
  key: string;
  bubble?: TeamChatBubble;
  /** true 表示这是「最终交付」气泡 */
  delivery?: boolean;
}

/**
 * 组装渲染序列：把「最终交付」气泡插到协作过程（非对话）末尾、后续对话之前，
 * 保持时间顺序——而不是永远钉在消息流最底部（那样每来一条新对话，
 * 交付气泡都像又冒出来的最新消息）。
 */
export function buildTeamChatRenderItems(
  bubbles: TeamChatBubble[],
  hasDelivery: boolean,
): TeamChatRenderItem[] {
  const items: TeamChatRenderItem[] = bubbles.map((b) => ({ key: b.id, bubble: b }));
  if (!hasDelivery) return items;
  let insertAt = items.length;
  for (let i = bubbles.length - 1; i >= 0; i -= 1) {
    const b = bubbles[i];
    const isDialogue = b.kind === 'user' || b.peerId === 'user';
    if (!isDialogue) {
      insertAt = i + 1;
      break;
    }
    // 纯对话流：交付插在对话之前
    insertAt = i;
  }
  items.splice(insertAt, 0, { key: '__delivery__', delivery: true });
  return items;
}

/**
 * 解析 leader 回复里的执行标记 [EXECUTE]。
 * 命中时返回剥离标记后的正文 + execute=true，调用方据此触发真实编排。
 * 标记必须出现在行尾独立成行，避免正文里偶然提到该词被误判。
 */
export function parseExecuteMarker(reply: string): { text: string; execute: boolean } {
  const m = /(?:^|\n)\s*\[EXECUTE\]\s*$/.exec(reply);
  if (!m) return { text: reply, execute: false };
  return { text: reply.slice(0, m.index).trimEnd(), execute: true };
}

/**
 * 派活意图分类器的消息组（独立小调用，不污染 leader 人设回复）。
 * 只答 YES/NO；调用方用 runRealChat(msgs, 4) 后判 YES。
 */
export function buildWorkOrderClassifierMessages(
  text: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return [
    {
      role: 'system',
      content:
        '判断老板对团队说的话是否是在派活、提修改意见或追加需求（需要团队实际动手执行）。' +
        '闲聊、打招呼、问进度、问团队成员、纯讨论都不算派活。只回答 YES 或 NO，不要输出任何其它内容。',
    },
    { role: 'user', content: text },
  ];
}
