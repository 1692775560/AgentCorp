/**
 * src/engine/squad/squadOrchestration.ts
 * 多 Agent 员工协同编排器：一个团队（leader + N 个成员）协同完成一条任务。
 *
 * 这不是 mock：leader 与所有成员都是真实 LLM agent，消息在它们之间真实往返，
 * 每一步都产出符合项目既有 schema 的 A2aTraceRecord（见 src/types/evaluation.ts）。
 * 流程五步：
 *
 *   1. DECOMPOSE（leader）：把任务拆成若干子任务，输出 JSON
 *      [{title, instruction, assigneeId?}]；解析失败兜底为单子任务（原任务）。
 *   2. ASSIGN（leader）：校验 assigneeId 是否团队成员；缺失/非法时用
 *      routeBySquadLeader 按子任务内容对成员画像打分兜底指派。
 *   3. EXECUTE（成员，并行）：各成员按 persona + 子任务指令产出真实交付物；
 *      单成员失败不阻塞全局（记 error 产出，进入汇总时如实标注）。
 *   4. REVIEW（leader）：逐个子任务判 PASS / REWORK+修改意见；REWORK 回成员
 *      重做，受 maxRounds 限制。
 *   5. SUMMARIZE（leader）：把全部子任务产出汇总成一份交付物。
 *
 * 环境无关：通过注入 `chat(agentId, messages)` 执行函数解耦运行环境
 * （浏览器走 /api/llm/chat 代理，Node 脚本直连真实 LLM）。注意注入实现
 * 可能忽略 agentId（如 autoWorker 中的 runRealChat 包装），因此本模块把
 * persona / 身份说明直接拼进 system 消息，不依赖 chat 内部按 agentId 区分人格。
 */
import type { A2aTraceRecord, A2aTraceState } from '../../types/evaluation';
import type { Team } from '../../types/team';
import type { ChatFn, ChatMessage } from './squadCollaboration';
import { routeBySquadLeader, type RoutingCandidate } from './squadRouting';

/** leader 拆解出的一条子任务。assigneeId 可缺省（由 ASSIGN 兜底指派）。 */
export interface OrchestrationSubTask {
  title: string;
  instruction: string;
  assigneeId?: string;
}

export interface OrchestrationInput {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  /** 执行任务的团队（leaderId + memberIds 决定合法指派范围）。 */
  team: Team;
  /** 团队成员（含 leader）的路由画像投影，用于 ASSIGN 兜底打分。 */
  candidates: RoutingCandidate[];
  /** agentId → persona 文本（SOUL.md 摘要）；缺失的成员退回纯身份说明。 */
  personas?: Record<string, string | null>;
  /** 单个子任务最大返工轮数（含首轮），默认 2。 */
  maxRounds?: number;
  chat: ChatFn;
  /** 每产生一条 A2A trace 时回调（用于实时展示 / 落盘）。 */
  onTrace?: (trace: A2aTraceRecord) => void;
}

export interface SubTaskResult {
  title: string;
  assigneeId: string;
  /** 指派方式：leader 拆解时指定 / 路由兜底 / 兜底自留。 */
  assignedBy: 'decompose' | 'routing' | 'fallback';
  approved: boolean;
  rounds: number;
  /** 最终产出；执行失败时为 null 且 error 有值。 */
  output: string | null;
  /** leader 最终审阅结论 */
  verdict: string;
  error?: string;
}

export interface OrchestrationResult {
  subtasks: SubTaskResult[];
  /** leader 汇总后的最终交付物 */
  deliverable: string;
  /** 完整 A2A 协议轨迹（真实往返） */
  traces: A2aTraceRecord[];
}

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

/** 与 squadCollaboration.makeTrace 同构（它未导出，这里复制一份避免改动旧文件）。 */
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

/** 拼 system 消息：persona（如有）+ 身份说明。 */
function personaSystem(personas: Record<string, string | null> | undefined, agentId: string, roleLine: string): string {
  const persona = personas?.[agentId]?.trim();
  const parts = [roleLine];
  if (persona) parts.push(`你的工作风格与人格设定：\n${persona}`);
  parts.push(`（你的 agentId 是 ${agentId}）`);
  return parts.join('\n\n');
}

/** 容错解析 leader 拆解输出：提取 ```json 块或首个 JSON 数组。 */
export function parseSubTasks(raw: string): OrchestrationSubTask[] | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1);
  if (!candidate || !candidate.trim().startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const subtasks: OrchestrationSubTask[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') return null;
      const o = item as Record<string, unknown>;
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      const instruction = typeof o.instruction === 'string' ? o.instruction.trim() : '';
      if (!title || !instruction) return null;
      subtasks.push({
        title,
        instruction,
        ...(typeof o.assigneeId === 'string' && o.assigneeId.trim()
          ? { assigneeId: o.assigneeId.trim() }
          : {}),
      });
    }
    return subtasks;
  } catch {
    return null;
  }
}

/**
 * 多 Agent 协同编排主入口。返回各子任务结果 + leader 汇总交付物 + 完整 trace。
 */
export async function runSquadOrchestration(
  input: OrchestrationInput,
): Promise<OrchestrationResult> {
  const { taskId, taskTitle, taskDescription, team, candidates, personas, chat } = input;
  const maxRounds = Math.max(1, input.maxRounds ?? 2);
  const rootId = id('root');
  const traces: A2aTraceRecord[] = [];
  const emit = (t: A2aTraceRecord) => {
    traces.push(t);
    input.onTrace?.(t);
  };

  const taskText = [taskTitle, taskDescription].filter(Boolean).join('\n');
  // 合法指派范围：团队成员 ∪ leader（去重）。
  const memberIds = Array.from(new Set([...(team.memberIds ?? []), team.leaderId]));

  // —— 步骤 1：DECOMPOSE（leader 拆任务）——
  const roster = candidates
    .map((c) => `- ${c.agentId}${c.jobType ? `（擅长工种：${c.jobType}）` : ''}${c.agentId === team.leaderId ? '（leader）' : ''}`)
    .join('\n');
  const decomposeRaw = await chat(team.leaderId, [
    {
      role: 'system',
      content: personaSystem(
        personas,
        team.leaderId,
        '你是团队 leader，负责把任务拆解为可并行执行的子任务并指派给团队成员。' +
          '只输出一个 JSON 数组，不要输出任何其它文字：[{"title":"子任务标题","instruction":"给成员的具体指令与验收标准","assigneeId":"成员agentId（可选）"}]。' +
          `团队成员如下：\n${roster}\n` +
          '拆解为 1~5 条；每条 instruction 控制在 120 字内。',
      ),
    },
    { role: 'user', content: `任务：\n${taskText}` },
  ]);

  // 解析失败 / 空数组 → 兜底为单子任务（原任务），诚实继续而非假装拆解成功。
  const subtasks: OrchestrationSubTask[] = parseSubTasks(decomposeRaw) ?? [
    { title: taskTitle, instruction: taskDescription || taskTitle },
  ];
  emit(
    makeTrace({
      taskId,
      rootId,
      delegator: `agent:${team.leaderId}`,
      delegatee: `team:${team.id}`,
      round: 1,
      state: 'working',
      summary: `Leader 拆解任务为 ${subtasks.length} 个子任务：${subtasks.map((s) => s.title).join('；').slice(0, 60)}`,
    }),
  );

  // —— 步骤 2：ASSIGN（校验 / 兜底指派）——
  const assigned = subtasks.map((st): SubTaskResult => {
    const legal = st.assigneeId && memberIds.includes(st.assigneeId);
    if (legal) {
      return {
        title: st.title,
        assigneeId: st.assigneeId!,
        assignedBy: 'decompose',
        approved: false,
        rounds: 0,
        output: null,
        verdict: '',
      };
    }
    // 缺失 / 非法指派 → 按子任务内容对成员画像打分路由兜底。
    const decision = routeBySquadLeader({
      taskText: `${st.title}\n${st.instruction}`,
      leaderId: team.leaderId,
      candidates,
    });
    return {
      title: st.title,
      assigneeId: decision.assigneeId || team.leaderId,
      assignedBy: decision.assigneeId ? 'routing' : 'fallback',
      approved: false,
      rounds: 0,
      output: null,
      verdict: decision.reason,
    };
  });
  for (const st of assigned) {
    emit(
      makeTrace({
        taskId,
        rootId,
        delegator: `agent:${team.leaderId}`,
        delegatee: `agent:${st.assigneeId}`,
        round: 1,
        state: 'submitted',
        summary: `子任务「${st.title.slice(0, 30)}」指派给 ${st.assigneeId}（${st.assignedBy === 'decompose' ? 'leader 指定' : '路由兜底'}）`,
      }),
    );
  }

  // —— 步骤 3+4：EXECUTE ∥ REVIEW（各子任务并行，单成员失败不阻塞）——
  await Promise.all(
    assigned.map(async (st, idx) => {
      const instruction = subtasks[idx].instruction;
      let lastReworkTrace: string | null = null;
      try {
        while (st.rounds < maxRounds) {
          st.rounds += 1;

          // EXECUTE：成员按 persona + 指令产出交付物。
          const executeMsgs: ChatMessage[] = [
            {
              role: 'system',
              content: personaSystem(
                personas,
                st.assigneeId,
                '你是团队中的执行成员。严格按 leader 指令产出可交付的真实成果，直接给结果，不要复述指令。控制在 300 字内。',
              ),
            },
            {
              role: 'user',
              content: `Leader 指令：\n${instruction}\n\n原任务背景：\n${taskText}`,
            },
          ];
          if (st.verdict && st.rounds > 1) {
            executeMsgs.push({
              role: 'user',
              content: `上一轮被 leader 打回，返工意见：\n${st.verdict}\n请据此修订你的产出。`,
            });
          }
          st.output = await chat(st.assigneeId, executeMsgs);
          emit(
            makeTrace({
              taskId,
              rootId,
              delegator: `agent:${st.assigneeId}`,
              delegatee: `agent:${team.leaderId}`,
              round: st.rounds,
              state: 'working',
              summary: `「${st.title.slice(0, 24)}」成员回交产出（第${st.rounds}轮）：${st.output.slice(0, 50)}`,
              reworkOf: lastReworkTrace,
            }),
          );

          // REVIEW：leader 审阅该子任务产出。
          const reviewRaw = await chat(team.leaderId, [
            {
              role: 'system',
              content: personaSystem(
                personas,
                team.leaderId,
                `你是团队 leader，审阅成员 ${st.assigneeId} 对子任务「${st.title}」的产出。` +
                  '第一行只输出 PASS 或 REWORK；第二行起给出一句理由（打回则给出修改意见）。',
              ),
            },
            {
              role: 'user',
              content: `子任务要求：\n${instruction}\n\n成员产出：\n${st.output}`,
            },
          ]);
          const firstLine = reviewRaw.trim().split('\n')[0].toUpperCase();
          st.approved = firstLine.includes('PASS');
          st.verdict = reviewRaw.trim();

          const reviewTrace = makeTrace({
            taskId,
            rootId,
            delegator: `agent:${team.leaderId}`,
            delegatee: `agent:${st.assigneeId}`,
            round: st.rounds,
            state: st.approved ? 'completed' : 'input-required',
            summary: `「${st.title.slice(0, 24)}」Leader 审阅：${st.approved ? 'PASS' : 'REWORK'} — ${st.verdict.slice(0, 40)}`,
            reworkOf: st.approved ? null : lastReworkTrace,
          });
          emit(reviewTrace);

          if (st.approved) break;
          lastReworkTrace = reviewTrace.trace_id; // 下一轮 EXECUTE 标记为对本次的返工
        }
      } catch (e) {
        // 单成员失败不阻塞全局：记 error，产出置空，trace 落 failed。
        st.error = e instanceof Error ? e.message : String(e);
        st.output = null;
        emit(
          makeTrace({
            taskId,
            rootId,
            delegator: `agent:${st.assigneeId}`,
            delegatee: `agent:${team.leaderId}`,
            round: Math.max(1, st.rounds),
            state: 'failed',
            summary: `「${st.title.slice(0, 24)}」执行失败：${st.error.slice(0, 50)}`,
          }),
        );
      }
    }),
  );

  // —— 步骤 5：SUMMARIZE（leader 汇总全部产出）——
  const digest = assigned
    .map((st, i) => {
      const body = st.error
        ? `（执行失败：${st.error}）`
        : `${st.output ?? ''}${st.approved ? '' : '\n（注意：该子任务未通过 leader 审阅）'}`;
      return `### 子任务${i + 1}：${st.title}（执行者 ${st.assigneeId}）\n${body}`;
    })
    .join('\n\n');
  const deliverable = await chat(team.leaderId, [
    {
      role: 'system',
      content: personaSystem(
        personas,
        team.leaderId,
        '你是团队 leader。下面是各成员对子任务的真实产出，请汇总成一份完整、连贯的最终交付物交付给用户。' +
          '如实反映各部分质量（含失败/未通过部分），不要编造不存在的内容。控制在 600 字内。',
      ),
    },
    { role: 'user', content: `原任务：\n${taskText}\n\n${digest}` },
  ]);
  emit(
    makeTrace({
      taskId,
      rootId,
      delegator: `agent:${team.leaderId}`,
      delegatee: `team:${team.id}`,
      round: 1,
      state: 'completed',
      summary: `Leader 汇总交付：${deliverable.slice(0, 60)}`,
    }),
  );

  return { subtasks: assigned, deliverable, traces };
}
