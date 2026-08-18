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

/**
 * 剥掉编排 trace 参与者 id 上的 `agent:`/`team:` 前缀（如 `agent:writer-01` → `writer-01`），
 * 还原成纯 id 供 UI 按 agents/teams 查找；无前缀时原样返回。
 */
export function stripActorPrefix(id: string): string {
  if (id.startsWith('agent:')) return id.slice('agent:'.length);
  if (id.startsWith('team:')) return id.slice('team:'.length);
  return id;
}

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
      // id 统一剥 agent:/team: 前缀，避免编排 trace 里的前缀泄漏到 UI 查找。
      const isUserSpeaking = chatRoute.from === 'user';
      return {
        id: `chat-${i}`,
        kind: isUserSpeaking ? 'user' : 'a2a',
        actorId: isUserSpeaking ? 'user' : stripActorPrefix(chatRoute.from),
        peerId: isUserSpeaking ? stripActorPrefix(chatRoute.to) : 'user',
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
      // actorId/peerId 统一剥 agent:/team: 前缀，否则 UI 按 id 查 agent 会落空、直接渲染乱码原串。
      actorId: stripActorPrefix(route.to || route.from),
      peerId: route.to ? stripActorPrefix(route.from) : '',
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
  /** 任务标题；团队房间日常沟通时不传 */
  taskTitle?: string;
  taskDescription?: string;
  teamName?: string;
  /** 最近交付摘要（截断后注入，帮成员对齐上下文） */
  workResultExcerpt?: string;
  /** 交付物是否已落盘可取（防止空口承诺「马上发给你」） */
  deliveryReady?: boolean;
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
    `你正在和老板${ctx.taskTitle ? `就团队任务「${ctx.taskTitle}」` : '进行团队日常'}直接沟通。`,
    ctx.taskDescription ? `任务要求：${ctx.taskDescription}` : '',
    ctx.workResultExcerpt ? `当前交付进展摘要：${ctx.workResultExcerpt}` : '',
    ctx.deliveryReady
      ? '交付物已保存到本地，界面上就有「打开/下载」入口。不要假装「马上发文件给你」——直接告诉老板去交付区获取即可。'
      : '',
    // 诚实约束：成员没有主动执行/发送的能力，动手只能靠系统触发编排
    '重要：你自己无法真的去执行或发送任何东西，不要承诺「马上弄好发给你」这类动作；' +
      '需要实际动手时，说明安排即可，系统会触发执行并展示过程。',
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
 * 三分类：REWORK=改当前任务 / NEW=新任务 / CHAT=闲聊追问；
 * 调用方用 runRealChat(msgs, 8) 后交给 parseWorkIntent 解析。
 */
export function buildWorkIntentClassifierMessages(
  text: string,
  hasCurrentTask: boolean,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return [
    {
      role: 'system',
      content:
        '判断老板对团队说的这句话的意图，只回答一个词：' +
        (hasCurrentTask
          ? 'REWORK（要求修改/返工/完善当前这个任务）、NEW（要求做一件新的事情/新的作品）、CHAT（闲聊、催促、问进度、问成员、纯讨论）。'
          : 'NEW（要求做一件事/一个作品）、CHAT（闲聊、催促、问进度、问成员、纯讨论）。') +
        '催促（如"快点""还没好吗"）本身不是新需求，算 CHAT。只输出这个词，不要任何其它内容。',
    },
    { role: 'user', content: text },
  ];
}

/** 解析意图分类结果；无法识别时回退 'chat'（保守不执行）。 */
export function parseWorkIntent(reply: string): 'rework' | 'new' | 'chat' {
  const token = reply.trim().toUpperCase();
  if (token.startsWith('REWORK')) return 'rework';
  if (token.startsWith('NEW')) return 'new';
  return 'chat';
}

/** 聊天滚动判定：用户是否停留在接近底部的位置（阈值内才允许自动滚底）。 */
export function isNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 80,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * 团队房间聊天记录 → 气泡。TeamChatEvent.from 为 'user' 时是老板发言（右列），
 * 否则是成员发言（左列，actorId=from）。from/to 同样剥 agent:/team: 前缀，
 * 防止编排 trace 桥接进来的带前缀 id 泄漏到 UI。
 */
export function mapTeamChatEventsToBubbles(
  events: Array<{ from: string; to: string; content: string; createdAt: string }>,
): TeamChatBubble[] {
  return events.map((e, i) => {
    const isUser = e.from === 'user';
    return {
      id: `room-${i}`,
      kind: isUser ? 'user' : 'a2a',
      actorId: isUser ? 'user' : stripActorPrefix(e.from),
      peerId: isUser ? stripActorPrefix(e.to) : 'user',
      text: e.content,
      round: null,
      verdict: null,
      createdAt: e.createdAt,
    };
  });
}

/** 从派活指令生成看板任务标题：取首行，截断 24 字。 */
export function taskTitleFromInstruction(text: string): string {
  const firstLine = text.split('\n').map((s) => s.trim()).find(Boolean) ?? '团队任务';
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine;
}

/**
 * 从房间交付消息反查可验收任务。交付消息内容形如「标题」交付完成，请验收：…
 * （teamChatWorkOrder / autoWorker 同步到房间时不带 taskId），按标题匹配
 * 当前 status==='review' 的任务：唯一匹配才返回（多义/非 review 一律不显示按钮，
 * 防止误验收别的任务或给已处理的消息重复挂按钮）。
 */
export function findReviewTaskForDelivery<T extends { id: string; title: string; status: string }>(
  content: string,
  tasks: T[],
): T | null {
  const m = /^\s*「(.+?)」交付完成，请验收/.exec(content);
  if (!m) return null;
  const matches = tasks.filter((t) => t.status === 'review' && t.title === m[1]);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * @成员直派解析：消息 @ 了非 leader 成员且去掉提及后仍有指令正文 → 直派该成员。
 * 返回 null 时维持现状（@leader / 无 @ 走 leader 三路意图分类管线）。
 */
export function parseDirectAssignTarget(
  text: string,
  members: Array<{ id: string; name: string }>,
  leaderId: string | null,
): { targetId: string; targetName: string; instruction: string } | null {
  const mention = parseMentionTarget(text, members);
  if (!mention || mention.targetId === leaderId) return null;
  if (!mention.cleanText) return null;
  const targetName = members.find((m) => m.id === mention.targetId)?.name ?? '';
  return { targetId: mention.targetId, targetName, instruction: mention.cleanText };
}

/**
 * 直派编排指令：加「【指定执行：@成员名】」前缀，leader 拆解（DECOMPOSE）时
 * 自然会把活分给该成员——不动编排 prompt 也能把指定执行人传进管线。
 */
export function buildDirectAssignInstruction(memberName: string, instruction: string): string {
  return `【指定执行：@${memberName}】${instruction}`;
}
