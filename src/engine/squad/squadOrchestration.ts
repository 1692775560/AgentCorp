/**
 * src/engine/squad/squadOrchestration.ts
 * 多 Agent 员工协同编排器：一个团队（leader + N 个成员）协同完成一条任务。
 *
 * 这不是 mock：leader 与所有成员都是真实 LLM agent，消息在它们之间真实往返，
 * 每一步都产出符合项目既有 schema 的 A2aTraceRecord（见 src/types/evaluation.ts）。
 * 流程：
 *
 *   1. DECOMPOSE（leader）：把任务拆成若干子任务，输出 JSON
 *      [{title, instruction, assigneeId?}]；解析失败兜底为单子任务（原任务）。
 *   2. ASSIGN（leader）：校验 assigneeId 是否团队成员；缺失/非法时用
 *      routeBySquadLeader 按子任务内容对成员画像打分兜底指派。
 *   2.5 KICKOFF 开工确认（P2）：成员动手前可提一个最关键的问题，
 *      问题汇总成一次 leader 批量解答，解答注入该成员 EXECUTE 的 messages。
 *   3+4. EXECUTE ∥ REVIEW（成员并行 / leader 逐个审阅）：成员按 persona +
 *      子任务指令产出真实交付物（字数天花板按工种分级，P0-1）；REWORK 回成员
 *      重做，受 maxRounds 限制；执行失败自动改派其他成员重试一次（P0-2）。
 *   4.5 CROSS_REVIEW 交叉评审（P1-1）：≥2 个子任务通过时，成员互看他人产出，
 *      需要衔接/修订则输出修订版替换原产出（一轮封顶）。
 *   4.6 REPLAN 中途重规划（P1-2）：leader 看当前产出 digest，覆盖有缺口则
 *      追加子任务（最多 3 条、只重规划 1 次），走同一套 execute+review 管线。
 *   5. SUMMARIZE（leader）：把全部子任务产出汇总成一份交付物
 *      （上限按子任务数动态化：6000 + 2000/子任务，封顶 16000 字）。
 *
 * 健壮性：每个新步骤独立 try/catch，失败降级为原行为，绝不影响主流程。
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

/** 子任务工种分级（P0-1）：决定成员产出的字数天花板。 */
export type SubTaskKind = 'code' | 'long' | 'short';

/** 各级字数天花板：代码 4000 / 长文 2000 / 短答 800。 */
const KIND_WORD_LIMIT: Record<SubTaskKind, number> = {
  code: 4000,
  long: 2000,
  short: 800,
};

/** 按子任务标题+指令关键词粗分工种：代码类优先，其次长文类，否则短答类。 */
export function classifySubTaskKind(title: string, instruction: string): SubTaskKind {
  const text = `${title}\n${instruction}`.toLowerCase();
  if (/代码|实现|开发|网站|页面|html|css|脚本|程序|接口|应用/.test(text)) return 'code';
  if (/文案|方案|报告|分析|总结|设计|调研/.test(text)) return 'long';
  return 'short';
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

/**
 * 审阅结论首行判定：精确匹配行首 PASS / REWORK（词边界），先判 REWORK 再判 PASS。
 * 修复 `includes('PASS')` 把「REWORK：尚未 PASS」误判通过的问题；
 * 两者都不命中时保守视为未通过（不批准）。
 */
export function parseReviewVerdict(firstLine: string): 'PASS' | 'REWORK' {
  return /^\s*REWORK\b/i.test(firstLine) ? 'REWORK' : /^\s*PASS\b/i.test(firstLine) ? 'PASS' : 'REWORK';
}

/**
 * 归一化判定「OK」确认：取首行，去标点/空白/符号后大写，startsWith('OK')。
 * 容忍「OK，无需调整。」「ok.」等变体，避免把确认误判为修订版正文。
 */
export function firstLineIsOk(reply: string): boolean {
  const firstLine = reply.trim().split(/\r?\n/)[0] ?? '';
  const normalized = firstLine.replace(/[\s\p{P}\p{S}]/gu, '').toUpperCase();
  return normalized.startsWith('OK');
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
  const maxRounds = Math.max(1, input.maxRounds ?? 3);
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
          '拆解为 1~5 条；每条 instruction 控制在 120 字内，写清要做什么与验收标准；' +
          '不要在 instruction 里限制成员的产出字数（长度由系统按工种自动控制，人为压短会导致交付残缺）。',
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
  /** 单条子任务指派：leader 指定合法则用，否则路由兜底。 */
  const assignOne = (st: OrchestrationSubTask): SubTaskResult => {
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
  };
  const emitAssignTrace = (st: SubTaskResult) =>
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

  const assigned = subtasks.map(assignOne);
  for (const st of assigned) emitAssignTrace(st);

  // —— 单个子任务的 EXECUTE ∥ REVIEW 循环（REPLAN 追加的子任务复用）——
  const executeReviewLoop = async (
    st: SubTaskResult,
    instruction: string,
    kickoffQA?: string,
  ): Promise<void> => {
    // P0-1：字数天花板按工种分级（code 4000 / long 2000 / short 800）。
    const wordLimit = KIND_WORD_LIMIT[classifySubTaskKind(st.title, instruction)];
    let lastReworkTrace: string | null = null;
    while (st.rounds < maxRounds) {
      st.rounds += 1;

      // EXECUTE：成员按 persona + 指令产出交付物。
      const executeMsgs: ChatMessage[] = [
        {
          role: 'system',
          content: personaSystem(
            personas,
            st.assigneeId,
            '你是团队中的执行成员。严格按 leader 指令产出可交付的真实成果，直接给结果，不要复述指令。' +
              `控制在 ${wordLimit} 字内。`,
          ),
        },
        {
          role: 'user',
          content: `Leader 指令：\n${instruction}\n\n原任务背景：\n${taskText}`,
        },
      ];
      // P2：开工确认的 Q&A 作为附加上下文注入首轮执行。
      if (kickoffQA && st.rounds === 1) {
        executeMsgs.push({
          role: 'user',
          content: `【开工确认·你的提问与 leader 解答】\n${kickoffQA}`,
        });
      }
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

      // REVIEW：leader 审阅该子任务产出；第 2 轮起带上轮意见，便于核对是否已解决。
      const reviewRaw = await chat(team.leaderId, [
        {
          role: 'system',
          content: personaSystem(
            personas,
            team.leaderId,
            `你是团队 leader，审阅成员 ${st.assigneeId} 对子任务「${st.title}」的产出。` +
              '第一行只输出 PASS 或 REWORK；第二行起给出一句理由（打回则给出修改意见）。' +
              '审阅标准：内容质量达标、要求已覆盖即 PASS；若上一轮返工意见已被逐条解决，应 PASS，不要翻新账。' +
              '不要要求成员做他们做不到的外部核验（如验证链接有效性、访问付费数据库）；对来源存疑可要求标注「来源待核验」而非打回。' +
              'REWORK 意见必须具体可执行，一次最多 3 条。',
          ),
        },
        {
          role: 'user',
          content:
            `子任务要求：\n${instruction}\n\n成员产出：\n${st.output}` +
            (st.rounds > 1 && st.verdict ? `\n\n上一轮审阅意见（请核对是否已被解决）：\n${st.verdict}` : ''),
        },
      ]);
      const firstLine = reviewRaw.trim().split('\n')[0];
      st.approved = parseReviewVerdict(firstLine) === 'PASS';
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
  };

  // —— 单个子任务处理：execute+review，失败自动改派一次（P0-2）——
  const runSubTask = async (
    st: SubTaskResult,
    instruction: string,
    kickoffQA?: string,
  ): Promise<void> => {
    const tried = new Set<string>([st.assigneeId]);
    try {
      await executeReviewLoop(st, instruction, kickoffQA);
      return;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // P0-2 失败自动改派：团队还有其他成员没试过该子任务时，
      // 路由选一个改派对象，重置轮数重跑一遍（最多改派 1 次）。
      const rest = candidates.filter((c) => !tried.has(c.agentId));
      const decision = rest.length
        ? routeBySquadLeader({
            taskText: `${st.title}\n${instruction}`,
            leaderId: team.leaderId,
            candidates: rest,
          })
        : null;
      const next = decision?.assigneeId;
      if (next && !tried.has(next)) {
        emit(
          makeTrace({
            taskId,
            rootId,
            delegator: `agent:${team.leaderId}`,
            delegatee: `agent:${next}`,
            round: 1,
            state: 'working',
            summary: `「${st.title.slice(0, 24)}」执行失败，改派给 ${next} 重试：${errMsg.slice(0, 40)}`,
          }),
        );
        st.assigneeId = next;
        st.assignedBy = 'routing';
        st.rounds = 0;
        st.output = null;
        st.approved = false;
        st.verdict = '';
        st.error = undefined;
        try {
          await executeReviewLoop(st, instruction, kickoffQA);
          emit(
            makeTrace({
              taskId,
              rootId,
              delegator: `agent:${next}`,
              delegatee: `agent:${team.leaderId}`,
              round: Math.max(1, st.rounds),
              state: st.approved ? 'completed' : 'working',
              summary: `「${st.title.slice(0, 24)}」改派重试完成：${st.approved ? 'Leader 审阅通过' : '产出保留但未通过审阅'}`,
            }),
          );
          return;
        } catch (e2) {
          // 改派也失败：维持 error 终态。
          st.error = e2 instanceof Error ? e2.message : String(e2);
          st.output = null;
          emit(
            makeTrace({
              taskId,
              rootId,
              delegator: `agent:${next}`,
              delegatee: `agent:${team.leaderId}`,
              round: Math.max(1, st.rounds),
              state: 'failed',
              summary: `「${st.title.slice(0, 24)}」改派给 ${next} 后仍失败：${st.error.slice(0, 50)}`,
            }),
          );
          return;
        }
      }
      // 无可改派对象：单成员失败不阻塞全局，记 error，产出置空，trace 落 failed。
      st.error = errMsg;
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
  };

  // —— 步骤 2.5：KICKOFF 开工确认（P2，成员提问 → leader 一次批量解答）——
  const kickoffQA = new Map<number, string>();
  if (memberIds.length > 1) {
    try {
      const questions: { idx: number; assigneeId: string; question: string }[] = [];
      await Promise.all(
        assigned.map(async (st, idx) => {
          try {
            const reply = await chat(st.assigneeId, [
              {
                role: 'system',
                content: personaSystem(
                  personas,
                  st.assigneeId,
                  '开工确认：你是团队中的执行成员，动手前先确认分工。看清指派给你的子任务指令与任务背景：' +
                    '若对分工边界、成员间接口约定或交付形式有疑问，只提一个最关键的问题；' +
                    '若没有疑问，第一行只输出 OK。',
                ),
              },
              {
                role: 'user',
                content: `指派给你的子任务：「${st.title}」\nLeader 指令：\n${subtasks[idx].instruction}\n\n原任务背景：\n${taskText}`,
              },
            ]);
            if (!firstLineIsOk(reply)) {
              questions.push({ idx, assigneeId: st.assigneeId, question: reply.trim().slice(0, 300) });
            }
          } catch {
            /* 单条提问失败视为无问题 */
          }
        }),
      );
      // 有问题才发起 leader 批量解答（一次调用），全部 OK 则跳过。
      if (questions.length > 0) {
        const qaText = await chat(team.leaderId, [
          {
            role: 'system',
            content: personaSystem(
              personas,
              team.leaderId,
              '开工确认：你是团队 leader。下面是成员动手前提出的问题，请逐条编号批量解答，' +
                '每条一两句给出明确约定（分工边界 / 接口格式 / 交付形式），不要展开发挥。',
            ),
          },
          {
            role: 'user',
            content:
              `原任务：\n${taskText}\n\n成员提问：\n` +
              questions.map((q, i) => `${i + 1}.（${q.assigneeId}）${q.question}`).join('\n'),
          },
        ]);
        for (const q of questions) {
          kickoffQA.set(q.idx, `你的问题：${q.question}\nLeader 解答：\n${qaText}`);
        }
        emit(
          makeTrace({
            taskId,
            rootId,
            delegator: `agent:${team.leaderId}`,
            delegatee: `team:${team.id}`,
            round: 1,
            state: 'working',
            summary: `开工确认：成员提出 ${questions.length} 个问题，leader 已解答`,
          }),
        );
      }
    } catch {
      /* 开工确认整体失败降级：跳过问答，照常执行 */
    }
  }

  // —— 步骤 3+4：EXECUTE ∥ REVIEW（各子任务并行，单成员失败不阻塞）——
  await Promise.all(
    assigned.map((st, idx) => runSubTask(st, subtasks[idx].instruction, kickoffQA.get(idx))),
  );

  // —— 步骤 4.5：CROSS_REVIEW 成员交叉评审（P1-1，一轮封顶）——
  try {
    const reviewable = assigned.filter((st) => st.approved && !st.error);
    if (reviewable.length >= 2) {
      await Promise.all(
        reviewable.map(async (st) => {
          try {
            const others = reviewable
              .filter((o) => o !== st)
              .map((o) => `### ${o.title}（执行者 ${o.assigneeId}）\n${(o.output ?? '').slice(0, 800)}`)
              .join('\n\n');
            const reply = await chat(st.assigneeId, [
              {
                role: 'system',
                content: personaSystem(
                  personas,
                  st.assigneeId,
                  `交叉评审：你是团队中的执行成员，刚完成子任务「${st.title}」。下面是其他成员负责子任务的标题与产出。` +
                    '若你的产出需要与他人衔接或据此修订，直接输出修订后的完整版本；' +
                    '若无需调整，第一行只输出 OK。',
                ),
              },
              {
                role: 'user',
                content:
                  `你的子任务：「${st.title}」\n你的产出：\n${(st.output ?? '').slice(0, 800)}` +
                  `\n\n其他子任务产出：\n${others}`,
              },
            ]);
            const revised = reply.trim();
            // 「OK，无需调整。」等确认变体归一化后仍判 OK，不当修订版；
            // 且修订版必须足够长（> 原产出的 50% 或 >200 字），防止一句话回复覆盖真实产出。
            const longEnough =
              revised.length > (st.output?.length ?? 0) * 0.5 || revised.length > 200;
            if (!firstLineIsOk(reply) && longEnough) {
              st.output = revised;
              emit(
                makeTrace({
                  taskId,
                  rootId,
                  delegator: `agent:${st.assigneeId}`,
                  delegatee: `agent:${team.leaderId}`,
                  round: Math.max(1, st.rounds),
                  state: 'working',
                  summary: `「${st.title.slice(0, 24)}」交叉评审后修订产出：${st.output.slice(0, 50)}`,
                }),
              );
            }
          } catch {
            /* 单条交叉评审失败跳过，不影响全局 */
          }
        }),
      );
    }
  } catch {
    /* 交叉评审整体失败降级：保留原产出 */
  }

  // —— 步骤 4.6：REPLAN leader 中途重规划（P1-2，最多一次、最多追加 3 条）——
  try {
    const replanRaw = await chat(team.leaderId, [
      {
        role: 'system',
        content: personaSystem(
          personas,
          team.leaderId,
          '重规划：你是团队 leader，正在中途检查任务覆盖情况。下面是各成员当前的子任务产出。' +
            '若发现原任务覆盖有缺口、还缺必要的子任务，输出一个 JSON 数组追加子任务' +
            '（格式与初始拆分相同：[{"title":"...","instruction":"...","assigneeId":"可选"}]，最多 3 条）；' +
            '若覆盖已完整无需追加，第一行只输出 OK。',
        ),
      },
      { role: 'user', content: `原任务：\n${taskText}\n\n${buildDigest(assigned)}` },
    ]);
    const extra = parseSubTasks(replanRaw);
    if (extra) {
      const toAdd = extra.slice(0, 3);
      emit(
        makeTrace({
          taskId,
          rootId,
          delegator: `agent:${team.leaderId}`,
          delegatee: `team:${team.id}`,
          round: 1,
          state: 'working',
          summary: `Leader 重规划：追加 ${toAdd.length} 个子任务：${toAdd.map((s) => s.title).join('；').slice(0, 60)}`,
        }),
      );
      // 追加的子任务走同一套 指派 → execute+review 管线。
      const appended = toAdd.map(assignOne);
      for (const st of appended) {
        assigned.push(st);
        emitAssignTrace(st);
      }
      await Promise.all(appended.map((st, i) => runSubTask(st, toAdd[i].instruction)));
    }
  } catch {
    /* 重规划失败降级：按现有产出直接汇总 */
  }

  // —— 步骤 5：SUMMARIZE（leader 汇总全部产出）——
  // 汇总上限按子任务规模动态化：底数 6000 + 每个子任务 2000，封顶 16000。
  // 固定小上限会让多子任务报告在句子中间被砍断（真实事故：6 子任务调研报告限 4000 字）。
  const summarizeLimit = Math.min(6000 + assigned.length * 2000, 16000);
  const deliverable = await chat(team.leaderId, [
    {
      role: 'system',
      content: personaSystem(
        personas,
        team.leaderId,
        '你是团队 leader。下面是各成员对子任务的真实产出，请汇总成一份完整、连贯的最终交付物交付给用户。' +
          '如实反映各部分质量（含失败/未通过部分），不要编造不存在的内容。' +
          `交付物可以写得完整充分，上限 ${summarizeLimit} 字；不要为压缩篇幅砍掉实质内容（数据、表格、案例都要保留）。`,
      ),
    },
    { role: 'user', content: `原任务：\n${taskText}\n\n${buildDigest(assigned)}` },
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

/** 汇总/重规划共用的产出 digest：逐子任务列出执行者与产出（含失败/未通过标注）。 */
function buildDigest(list: SubTaskResult[]): string {
  return list
    .map((st, i) => {
      const body = st.error
        ? `（执行失败：${st.error}）`
        : `${st.output ?? ''}${st.approved ? '' : '\n（注意：该子任务未通过 leader 审阅）'}`;
      return `### 子任务${i + 1}：${st.title}（执行者 ${st.assigneeId}）\n${body}`;
    })
    .join('\n\n');
}
