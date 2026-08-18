/**
 * src/engine/squad/squadCollaboration.ts
 * 真实的 Agent-to-Agent（A2A）协作协议编排。
 *
 * 这不是 mock：leader 与成员都是真实 LLM agent，消息按 A2A 协议在它们之间
 * 来回传递，每一条 agent 间消息都产出一条符合项目既有 schema 的 A2aTraceRecord
 * （见 src/types/evaluation.ts）。协议三步：
 *
 *   1. DELEGATE（leader → 成员）：leader 读任务，给出下发指令与验收标准。
 *   2. EXECUTE（成员 → leader）：成员按指令产出真实交付物，回交 leader。
 *   3. REVIEW（leader → 完成/返工）：leader 审阅成员产出，判定通过或打回。
 *      打回则以 rework_of 指向上一轮，进入下一轮 EXECUTE（受 maxRounds 限制）。
 *
 * 环境无关：通过注入 `chat(agentId, messages)` 执行函数解耦运行环境
 * （浏览器走 /api/llm/chat 代理，Node 脚本直连真实 LLM）。
 */
import type { A2aTraceRecord, A2aTraceState } from '../../types/evaluation';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 调用提示：按环节分档的输出 token 额度等（实现方缺省回退自身默认）。 */
export interface ChatHints {
  /** 本次调用的 maxTokens；拆解/审阅等短输出环节给小额度，避免推理模型空烧。 */
  maxTokens?: number;
}

/** 注入的真实 LLM 执行函数：给定 agent 与消息，返回真实文本产出。 */
export type ChatFn = (agentId: string, messages: ChatMessage[], hints?: ChatHints) => Promise<string>;

export interface CollaborationInput {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  leaderId: string;
  memberId: string;
  /** 最大返工轮数（含首轮），默认 2。 */
  maxRounds?: number;
  chat: ChatFn;
  /** 每产生一条 A2A trace 时回调（用于实时展示 / 落盘）。 */
  onTrace?: (trace: A2aTraceRecord) => void;
}

export interface CollaborationResult {
  approved: boolean;
  rounds: number;
  /** leader 最终审阅结论 */
  verdict: string;
  /** 被采纳的成员交付物 */
  deliverable: string;
  /** 完整 A2A 协议轨迹（真实往返） */
  traces: A2aTraceRecord[];
}

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

function makeTrace(p: {
  taskId: string;
  rootId: string;
  delegator: string;
  delegatee: string;
  round: number;
  state: A2aTraceState;
  summary: string;
  reworkOf?: string | null;
}): A2aTraceRecord {
  const now = new Date().toISOString();
  return {
    trace_id: id('trace'),
    task_id: p.taskId,
    parent_task_id: p.rootId,
    delegator: p.delegator,
    delegatee: p.delegatee,
    round: p.round,
    kind: 'message',
    state: p.state,
    rework_of: p.reworkOf ?? null,
    channel: 'internal-rpc',
    sent_at: now,
    completed_at: p.state === 'completed' || p.state === 'failed' ? now : null,
    summary: p.summary,
    session_key: `local:${p.delegatee}`,
    root_session_id: p.rootId,
    trigger: p.round === 1 ? 'spawn' : 'steer',
  };
}

/**
 * 跑一条真实的 A2A 协作协议往返，返回结论 + 完整 trace。
 */
export async function runSquadCollaboration(
  input: CollaborationInput,
): Promise<CollaborationResult> {
  const { taskId, taskTitle, taskDescription, leaderId, memberId, chat } = input;
  const maxRounds = Math.max(1, input.maxRounds ?? 2);
  const rootId = id('root');
  const traces: A2aTraceRecord[] = [];
  const emit = (t: A2aTraceRecord) => {
    traces.push(t);
    input.onTrace?.(t);
  };

  const taskText = [taskTitle, taskDescription].filter(Boolean).join('\n');

  // —— 步骤 1：DELEGATE（leader → 成员）——
  const delegateInstruction = await chat(leaderId, [
    {
      role: 'system',
      content:
        `你是团队 leader（agentId=${leaderId}）。你要把任务下发给成员 ${memberId}。` +
        '请只输出对该成员的清晰下发指令 + 验收标准，不要自己完成任务。控制在 120 字内。',
    },
    { role: 'user', content: `任务：\n${taskText}` },
  ]);
  emit(
    makeTrace({
      taskId,
      rootId,
      delegator: `agent:${leaderId}`,
      delegatee: `agent:${memberId}`,
      round: 1,
      state: 'submitted',
      summary: `Leader 下发指令：${delegateInstruction.slice(0, 60)}`,
    }),
  );

  let deliverable = '';
  let verdict = '';
  let approved = false;
  let round = 0;
  let lastReworkTrace: string | null = null;

  while (round < maxRounds) {
    round += 1;

    // —— 步骤 2：EXECUTE（成员 → leader）——
    const executeMsgs: ChatMessage[] = [
      {
        role: 'system',
        content:
          `你是执行成员（agentId=${memberId}）。严格按 leader 指令产出可交付的真实成果，` +
          '直接给结果，不要复述指令。控制在 200 字内。',
      },
      { role: 'user', content: `Leader 指令：\n${delegateInstruction}\n\n原任务：\n${taskText}` },
    ];
    if (verdict) {
      executeMsgs.push({
        role: 'user',
        content: `上一轮被 leader 打回，返工意见：\n${verdict}\n请据此修订你的产出。`,
      });
    }
    deliverable = await chat(memberId, executeMsgs);
    emit(
      makeTrace({
        taskId,
        rootId,
        delegator: `agent:${memberId}`,
        delegatee: `agent:${leaderId}`,
        round,
        state: 'working',
        summary: `成员回交产出（第${round}轮）：${deliverable.slice(0, 60)}`,
        reworkOf: lastReworkTrace,
      }),
    );

    // —— 步骤 3：REVIEW（leader 审阅）——
    const reviewRaw = await chat(leaderId, [
      {
        role: 'system',
        content:
          `你是团队 leader（agentId=${leaderId}），审阅成员 ${memberId} 的产出。` +
          '第一行只输出 PASS 或 REWORK；第二行起给出一句理由（打回则给出修改意见）。',
      },
      { role: 'user', content: `原任务：\n${taskText}\n\n成员产出：\n${deliverable}` },
    ]);
    const firstLine = reviewRaw.trim().split('\n')[0].toUpperCase();
    approved = firstLine.includes('PASS');
    verdict = reviewRaw.trim();

    const reviewTrace = makeTrace({
      taskId,
      rootId,
      delegator: `agent:${leaderId}`,
      delegatee: `agent:${memberId}`,
      round,
      state: approved ? 'completed' : 'input-required',
      summary: `Leader 审阅：${approved ? 'PASS' : 'REWORK'} — ${verdict.slice(0, 50)}`,
      reworkOf: approved ? null : lastReworkTrace,
    });
    emit(reviewTrace);

    if (approved) break;
    lastReworkTrace = reviewTrace.trace_id; // 下一轮 EXECUTE 标记为对本次的返工
  }

  return { approved, rounds: round, verdict, deliverable, traces };
}
