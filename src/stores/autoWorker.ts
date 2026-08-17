/**
 * src/stores/autoWorker.ts
 * Agent Office · 自动任务 worker（S8/S9/S10，真实消费循环，非 mock）。
 *
 * 合并说明（以远程主干为主干、只叠加差异能力）：
 * 本文件不引入任何新表 / 新看板 / 新数据库。它完全构建在主干既有的
 * 任务 + execution 系统之上：
 *   - 任务读写走 useApprovalsStore（/api/tasks，文件存储的 KanbanTask）。
 *   - 派活走 useGatewayStore.rpc（真实网关 RPC）+ startTaskExecution（写 canonicalExecution）。
 *   - agent 会话键取 useAgentsStore 的 AgentSummary.mainSessionKey。
 *
 * 提供三项主干原本没有的能力：
 *   S8 自动 worker：网关连上后，自动领取 status='todo' 且 workState='idle' 的任务并派活。
 *   S9 自动重试：任务 workState 变 'failed' 且未达 maxAttempts 时，自动复位为可重跑并再次派活。
 *   S10 并发度控制：同时最多执行 N 条（默认 2，可 1..8 调节），claim 时防重复领取。
 *
 * 真实约束（诚实、不假装）：
 * - 只有网关真正连上（GatewayStatus.state === 'running'）才会投递；未连上则待命。
 * - 每个任务按 assigneeId 反查该 agent 的 mainSessionKey；无 sessionKey →
 *   updateTask 置 workState='failed' 并写明原因，绝不静默成功，也不对其自动重试
 *   （结构性失败重试也会一直缺 key，避免死循环）。
 */
import { create } from 'zustand';

import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { useApprovalsStore } from '@/stores/approvals';
import { useTeamsStore } from '@/stores/teams';
import { useChatStore } from '@/stores/chat';
import { useEvaluationStore } from '@/stores/evaluation';
import type { KanbanTask } from '@/types/task';
import {
  routeBySquadLeader,
  type RoutingCandidate,
} from '@/engine/squad/squadRouting';
import { runRealExecution, runRealChat, isRealExecutorAvailable } from '@/engine/llm/realExecutor';
import { runSquadCollaboration } from '@/engine/squad/squadCollaboration';
import { runSquadOrchestration } from '@/engine/squad/squadOrchestration';
import { buildDeliverableFiles } from '@/engine/squad/deliverableFiles';
import { invokeIpc } from '@/lib/api-client';
import { notifyTaskTerminal } from '@/lib/task-notify';
import type { Team } from '@/types/team';
import type { A2aTraceRecord } from '@/types/evaluation';
import type { TaskExecutionEvent } from '@/types/task';

/** 领取任务的轮询间隔（ms）。 */
const POLL_INTERVAL_MS = 3_000;
/** 网关 RPC 派活的默认超时（ms）。 */
const DISPATCH_TIMEOUT_MS = 120_000;
/** 并发度上限。 */
const MAX_CONCURRENCY = 8;
/** 默认最大尝试次数（含首次）。主干任务本身无此字段，由 worker 会话内跟踪。 */
const DEFAULT_MAX_ATTEMPTS = 3;

/** 网关是否真正连上（真实判断）。 */
function gatewayConnected(): boolean {
  return useGatewayStore.getState().status.state === 'running';
}

/**
 * 真实执行后端是否就绪（缓存）。首次探测由 syncWithGateway/_tick 触发。
 * 就绪后即使网关未连上，worker 也可跑真实 LLM 执行。
 */
let realExecutorReady = false;
let realExecutorProbed = false;
async function probeRealExecutor(): Promise<boolean> {
  // 只缓存「可用」结论；探测失败（如 dev server 尚未注入 env、代理未就绪）
  // 不锁定，下次执行时重新探测，避免一次失败导致整个会话永远走网关兜底。
  if (realExecutorProbed && realExecutorReady) return true;
  realExecutorProbed = true;
  try {
    realExecutorReady = await isRealExecutorAvailable();
  } catch {
    realExecutorReady = false;
  }
  return realExecutorReady;
}

/** worker 是否有可用的执行通道（真实 LLM 或已连网关）。 */
function canDispatch(): boolean {
  return realExecutorReady || gatewayConnected();
}

/** 按 agentId 反查真实 mainSessionKey；查不到返回 null。 */
function sessionKeyForAgent(agentId: string | undefined): string | null {
  if (!agentId) return null;
  const agent = useAgentsStore.getState().agents.find((a) => a.id === agentId);
  return agent?.mainSessionKey || null;
}

/**
 * worker 会话内的重试计数（taskId → 已尝试次数）。用模块级 Map 跟踪，
 * 不侵入主干 KanbanTask 的 schema / 文件存储。进程重启即清零，符合
 * “自动重试是运行期行为”的预期。
 */
const attemptCount = new Map<string, number>();

interface AutoWorkerState {
  /** 用户是否开启了自动执行（开关意图）。 */
  enabled: boolean;
  /** worker 是否正在循环中（enabled 且已启动定时器）。 */
  running: boolean;
  /** 并发度：同时最多执行多少条任务。 */
  concurrency: number;
  /** 每个任务的最大尝试次数（含首次）。 */
  maxAttempts: number;
  /** 当前在执行中的任务 id 集合（并发）。 */
  activeTaskIds: string[];
  /** 累计已处理任务数（本次会话）。 */
  processed: number;
  /** 最近一次说明（供 UI 显示）。 */
  note: string;
  enable: () => void;
  disable: () => void;
  /** 设置并发度（1..8）。 */
  setConcurrency: (n: number) => void;
  /** 内部：根据网关状态启动/暂停循环。 */
  syncWithGateway: () => void;
  /** 内部：跑一次「补满并发槽位」的 tick。 */
  _tick: () => Promise<void>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
/** 当前在途执行数（模块级，避免并发 tick 之间竞态）。 */
let inFlight = 0;
/** 本轮 tick 已在途 / 刚领取的任务 id，避免并发 claim 领到同一条。 */
const claimed = new Set<string>();

function clearTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export const useAutoWorkerStore = create<AutoWorkerState>((set, get) => ({
  enabled: false,
  running: false,
  concurrency: 2,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  activeTaskIds: [],
  processed: 0,
  note: '未开启',

  enable: () => {
    set({ enabled: true });
    get().syncWithGateway();
  },

  disable: () => {
    set({ enabled: false, running: false, note: '已关闭' });
    clearTimer();
  },

  setConcurrency: (n) => {
    const clamped = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(n)));
    set({ concurrency: clamped });
  },

  syncWithGateway: () => {
    const { enabled } = get();
    if (!enabled) {
      clearTimer();
      set({ running: false });
      return;
    }
    // 首次探测真实执行后端；探测完成后再次同步（异步，不阻塞）。
    if (!realExecutorProbed) {
      void probeRealExecutor().then(() => get().syncWithGateway());
    }
    if (!canDispatch()) {
      clearTimer();
      set({ running: false, note: '无可用执行通道，待命中（真实 LLM 或网关就绪后自动开始）' });
      return;
    }
    if (!timer) {
      set({
        running: true,
        note: realExecutorReady ? '运行中：真实 LLM 执行已就绪，自动领取待办任务' : '运行中：自动领取待办任务',
      });
      void get()._tick();
      timer = setInterval(() => void get()._tick(), POLL_INTERVAL_MS);
    }
  },

  _tick: async () => {
    if (ticking) return; // tick 自身不重入
    if (!get().enabled) return;
    if (!canDispatch()) {
      get().syncWithGateway(); // 执行通道全部不可用 → 暂停
      return;
    }
    ticking = true;
    try {
      const { concurrency } = get();
      const approvals = useApprovalsStore.getState();
      // 拉最新任务快照（真实读主干 /api/tasks）。
      await approvals.fetchTasks();

      while (inFlight < concurrency) {
        const tasks = useApprovalsStore.getState().tasks;
        // 可领取：todo 且 idle，且未被本轮领取 / 未在途。
        const next = tasks.find(
          (t) =>
            t.status === 'todo' &&
            t.workState === 'idle' &&
            !claimed.has(t.id),
        );
        if (!next) {
          if (inFlight === 0) set({ note: '运行中：暂无待办任务，等待新任务' });
          break;
        }
        // 逻辑 claim：标记后立即占槽，避免并发 tick / 并发循环重复领取。
        claimed.add(next.id);
        inFlight += 1;
        set((s) => ({
          activeTaskIds: [...s.activeTaskIds, next.id],
          note: `执行中 ${inFlight} 条（并发 ${concurrency}）`,
        }));
        void runOne(next, set, get);
      }
    } catch (e) {
      set({ note: `出错：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      ticking = false;
    }
  },
}));

/**
 * 决策对接层 · Squad Leader 路由（creator 选定）。
 *
 * 任务先给团队 leader，leader 依据成员真实画像决定分给哪个成员或自己做。
 * 仅当任务带 teamId、能定位到团队、且团队有 leader 时才触发；否则原样返回，
 * 沿用任务既有 assigneeId（不改变主干默认行为）。
 *
 * 决策落地：把选中的 assigneeId 写回任务，并把 leader 决策理由写入 workResult，
 * 使其在看板与 execution 事件流中可见（诚实留痕，非 mock）。
 *
 * 返回决策后应使用的 assigneeId、团队 leaderId，以及是否应走多 agent A2A 协作
 * （团队任务且 leader 与被指派成员不同）。
 */
interface LeaderRouting {
  assigneeId?: string;
  leaderId?: string;
  /** 是否满足多 agent 协作条件（leader ≠ 成员，且二者均为真实 agent）。 */
  collaborate: boolean;
}

/** 把团队成员（含 leader）投影成路由所需的最简画像（真实数据，离职/淘汰标 inactive）。 */
function projectRoutingCandidates(team: Team): RoutingCandidate[] {
  const agents = useAgentsStore.getState().agents;
  const profiles = useEvaluationStore.getState().profiles;
  const memberIds = Array.from(new Set([...(team.memberIds ?? []), team.leaderId]));
  return memberIds
    .map((id): RoutingCandidate | null => {
      const agent = agents.find((a) => a.id === id);
      if (!agent) return null;
      const profile = profiles[id];
      // retired（软退休/淘汰）不参与路由；缺省 lifecycleStatus 视为在职。
      const active = (agent.lifecycleStatus ?? 'active') !== 'retired';
      return {
        agentId: id,
        active,
        jobType: profile?.jobType ?? null,
        radar: profile?.radarLatest ?? null,
        userFit: profile?.userFitLatest ?? null,
      };
    })
    .filter((c): c is RoutingCandidate => c !== null);
}

async function resolveAssigneeViaLeader(task: KanbanTask): Promise<LeaderRouting> {
  if (!task.teamId) return { assigneeId: task.assigneeId, collaborate: false };

  const team = useTeamsStore.getState().teams.find((t) => t.id === task.teamId);
  if (!team || !team.leaderId) return { assigneeId: task.assigneeId, collaborate: false };

  const agents = useAgentsStore.getState().agents;
  const candidates = projectRoutingCandidates(team);

  const decision = routeBySquadLeader({
    taskText: [task.title, task.description].filter(Boolean).join('\n\n'),
    leaderId: team.leaderId,
    candidates,
  });

  const resolved = decision.assigneeId || task.assigneeId;
  // 只有决策结果与任务当前 assignee 不同（或原本未分配）时才回写，避免无谓写入。
  if (resolved && resolved !== task.assigneeId) {
    const assigneeAgent = agents.find((a) => a.id === resolved);
    await useApprovalsStore.getState().updateTask(task.id, {
      assigneeId: resolved,
      ...(assigneeAgent?.teamRole ? { assigneeRole: assigneeAgent.teamRole } : {}),
      workResult: `[Squad Leader 路由] ${decision.reason}`,
    });
  }
  // 多 agent 协作条件：leader 未自留（成员 ≠ leader）且成员真实存在。
  const collaborate =
    !decision.leaderKept &&
    !!resolved &&
    resolved !== team.leaderId &&
    agents.some((a) => a.id === resolved);
  return { assigneeId: resolved, leaderId: team.leaderId, collaborate };
}

/** 把一条 A2A trace 转成任务执行事件（供看板时间线渲染）。 */
function traceToEvent(t: A2aTraceRecord): TaskExecutionEvent {
  const status: TaskExecutionEvent['status'] =
    t.state === 'completed' ? 'done' : t.state === 'failed' ? 'failed' : 'working';
  return {
    type: `a2a:${t.delegator} → ${t.delegatee}`,
    createdAt: t.sent_at,
    status,
    content: `【第${t.round}轮】${t.summary}`,
    actorId: t.delegator,
  };
}

/** 执行事件写回节流间隔（ms）：编排期间每条 A2A 消息都立即 PUT 会引发写/渲染风暴。 */
const EVENT_FLUSH_INTERVAL_MS = 800;

/**
 * 事件写回节流器：事件先攒在内存数组，最多每 800ms 落一次库；
 * flush() 强制落库（任务结束/失败时必须调用，保证时间线不丢尾部事件）。
 * 导出供单测直接验证节流语义。
 */
export function createThrottledEventSink(taskId: string, events: TaskExecutionEvent[]) {
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let inFlightWrite: Promise<unknown> | null = null;

  const write = (): Promise<unknown> => {
    dirty = false;
    inFlightWrite = useApprovalsStore
      .getState()
      .updateTask(taskId, { executionEvents: [...events] })
      .catch(() => { /* 时间线写回失败不阻塞执行 */ });
    return inFlightWrite;
  };

  return {
    push(t: A2aTraceRecord): void {
      events.push(traceToEvent(t));
      dirty = true;
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          if (dirty) void write();
        }, EVENT_FLUSH_INTERVAL_MS);
      }
    },
    async flush(): Promise<void> {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (dirty) await write();
      // 等最后一次在途写完成，避免与后续终态 PUT 交错丢字段
      if (inFlightWrite) await inFlightWrite.catch(() => { });
    },
  };
}

/**
 * 执行单条任务：（可选）leader 路由 → 反查 sessionKey → 网关真实派活 →
 * startTaskExecution 记录 → 轮询 workState 终态 → done 流转 review / failed 走 S9 自动重试。
 */
async function runOne(
  task: KanbanTask,
  set: (partial: Partial<AutoWorkerState> | ((s: AutoWorkerState) => Partial<AutoWorkerState>)) => void,
  get: () => AutoWorkerState,
): Promise<void> {
  const approvals = useApprovalsStore.getState();
  const gateway = useGatewayStore.getState();

  const release = () => {
    inFlight = Math.max(0, inFlight - 1);
    claimed.delete(task.id);
    set((s) => ({
      activeTaskIds: s.activeTaskIds.filter((id) => id !== task.id),
      processed: s.processed + 1,
    }));
  };

  try {
    // 真实执行是否就绪（复用缓存，避免重复探测）。
    const realAvailable = realExecutorReady || (await probeRealExecutor());

    // 0. 团队任务判定：真实 LLM 可用时走多成员编排（leader 拆解 → 成员并行执行 →
    //    leader 审阅/返工 → 汇总），assignee 由编排器内部 ASSIGN 决定，不再预选；
    //    否则沿用原 leader 路由预选 assignee 的逻辑。
    const team = task.teamId
      ? useTeamsStore.getState().teams.find((t) => t.id === task.teamId)
      : undefined;
    // 兜底：老任务（建会话功能上线前创建的团队任务）被领取执行时补建会话条目。
    if (task.teamId) {
      useChatStore.getState().ensureTeamTaskSession({
        id: task.id,
        title: task.title,
        teamId: task.teamId,
        teamName: task.teamName ?? team?.name,
      });
    }
    const orchestrate = Boolean(team && team.leaderId && realAvailable);
    const routing = orchestrate
      ? { assigneeId: task.assigneeId, leaderId: team!.leaderId, collaborate: false }
      : await resolveAssigneeViaLeader(task);
    const resolvedAssigneeId = orchestrate
      ? task.assigneeId || team!.leaderId
      : routing.assigneeId;

    // 1. 反查真实 sessionKey。网关模式下无 key → failed（不自动重试，避免死循环）；
    //    真实 LLM 模式不依赖网关会话，用合成 key 兜底，保证任务可执行。
    let sessionKey = task.runtimeSessionKey || sessionKeyForAgent(resolvedAssigneeId);
    if (!sessionKey) {
      if (realAvailable) {
        sessionKey = `local:${resolvedAssigneeId ?? task.id}`;
      } else {
        await approvals.updateTask(task.id, {
          workState: 'failed',
          workError: '任务未分配 agent 或该 agent 未在网关注册会话（缺 mainSessionKey），无法自动执行',
        });
        release();
        return;
      }
    }

    const attempts = (attemptCount.get(task.id) ?? 0) + 1;
    attemptCount.set(task.id, attempts);

    const prompt = [task.title, task.description].filter(Boolean).join('\n\n');
    let sessionId = task.runtimeSessionId || sessionKey;
    let runId: string | undefined;
    let realOutput: string | null = null;
    /** 交付文件落盘目录（仅编排路径产出）。 */
    let deliverableDir: string | undefined;

    // 2. 真实执行优先：若真实 LLM 后端在线（Vite 代理已配置 key）：
    //    - 团队任务 → 多成员编排（leader 拆解 → 并行执行 → 审阅/返工 → 汇总）；
    //    - 二人协作条件 → leader↔单成员 A2A 往返；
    //    - 否则 → 单 agent 真实执行。
    //    非真实模式回退到网关 RPC。
    if (realAvailable) {
      await approvals.updateTask(task.id, { status: 'in-progress', workState: 'working' });
      try {
        if (orchestrate && team) {
          // —— 多成员编排：leader 拆解 → 成员并行执行 → leader 审阅/返工 → 汇总 ——
          const events: TaskExecutionEvent[] = [];
          // 事件节流写回：看板即时可见，但最多每 800ms 落一次库
          const sink = createThrottledEventSink(task.id, events);
          const memberIds = Array.from(new Set([...(team.memberIds ?? []), team.leaderId]));
          // 注入各成员 persona（SOUL.md 摘要）；读不到为 null，编排器退回纯身份说明。
          const personas: Record<string, string | null> = {};
          await Promise.all(
            memberIds.map(async (aid) => {
              personas[aid] = await useAgentsStore
                .getState()
                .getAgentPersona(aid)
                .catch(() => null);
            }),
          );
          let orch: Awaited<ReturnType<typeof runSquadOrchestration>>;
          try {
            orch = await runSquadOrchestration({
              taskId: task.id,
              taskTitle: task.title,
              taskDescription: task.description,
              team,
              candidates: projectRoutingCandidates(team),
              personas,
              maxRounds: 2,
              // 注入真实 LLM 执行；persona/身份由编排器拼进 system 消息。
              chat: (_agentId, messages) => runRealChat(messages, 2048),
              // 每产生一条 A2A 消息，实时 append 成执行事件（节流写回）。
              onTrace: (t) => sink.push(t),
            });
          } finally {
            // 成功/失败都必须把尾部事件落库，时间线不丢尾
            await sink.flush();
          }
          const passed = orch.subtasks.filter((s) => s.approved).length;
          const failedCount = orch.subtasks.filter((s) => s.error).length;
          realOutput =
            `【团队协同·${team.name}·${orch.subtasks.length} 个子任务：${passed} 通过` +
            `${failedCount ? `，${failedCount} 失败` : ''}】\n${orch.deliverable}`;
          // 交付文件落盘：各子任务完整产出（含代码全文）写成真实文件，
          // HTML 可直接双击运行；落盘失败不阻塞交付，仅不附目录。
          try {
            const files = buildDeliverableFiles(orch.subtasks, orch.deliverable);
            const saved = await invokeIpc<{ success: boolean; dir?: string; saved?: string[] }>(
              'task:saveDeliverables',
              { taskId: task.id, files },
            );
            if (saved.success && saved.dir) {
              deliverableDir = saved.dir;
              realOutput += `\n\n---\n📁 ${saved.saved?.length ?? 0} 个交付文件已保存到本地，点下方「打开交付目录」查看/运行。`;
            }
          } catch {
            /* 落盘失败不阻塞交付 */
          }
        } else if (routing.collaborate && routing.leaderId && resolvedAssigneeId) {
          // —— 多 agent A2A 协作：leader 分派 → 成员执行 → leader 审阅（可返工）——
          const events: TaskExecutionEvent[] = [];
          const sink = createThrottledEventSink(task.id, events);
          let collab: Awaited<ReturnType<typeof runSquadCollaboration>>;
          try {
            collab = await runSquadCollaboration({
              taskId: task.id,
              taskTitle: task.title,
              taskDescription: task.description,
              leaderId: routing.leaderId,
              memberId: resolvedAssigneeId,
              maxRounds: 2,
              // 注入真实 LLM 执行；agentId 作为身份写进系统提示。
              chat: (_agentId, messages) => runRealChat(messages, 2048),
              // 每产生一条 A2A 消息，实时 append 成执行事件（节流写回）。
              onTrace: (t) => sink.push(t),
            });
          } finally {
            await sink.flush();
          }
          realOutput = collab.approved
            ? `【A2A 协作完成·${collab.rounds}轮·Leader PASS】\n${collab.deliverable}`
            : `【A2A 协作未通过·已达${collab.rounds}轮】最后产出：\n${collab.deliverable}\n\nLeader 意见：${collab.verdict}`;
        } else {
          // —— 单 agent 真实执行 ——
          const system = [
            '你是 AgentCorp 中的一名专业执行 agent。',
            resolvedAssigneeId ? `你的 agentId 是 ${resolvedAssigneeId}。` : '',
            '请直接完成下面这条任务，给出可交付的真实产出（结论/代码/文案/方案），不要只复述任务。',
          ]
            .filter(Boolean)
            .join('\n');
          const result = await runRealExecution({ message: prompt, system, maxTokens: 2048 });
          realOutput = result.content;
        }
      } catch (execErr) {
        // 真实执行失败 → failed，交给 S9 判断是否重试。
        await approvals.updateTask(task.id, {
          workState: 'failed',
          workError: `真实执行失败：${execErr instanceof Error ? execErr.message : String(execErr)}`,
        });
        await maybeAutoRetry(task, get, set);
        release();
        return;
      }
    } else {
      // 回退：网关真实派活（复用主干标准 RPC 通道 chat.send）。
      try {
        const rpcResult = await gateway.rpc<{ runId?: string; sessionId?: string }>(
          'chat.send',
          { sessionKey, message: prompt },
          DISPATCH_TIMEOUT_MS,
        );
        runId = rpcResult?.runId;
        if (rpcResult?.sessionId) sessionId = rpcResult.sessionId;
      } catch (rpcErr) {
        await approvals.updateTask(task.id, {
          workState: 'failed',
          workError: `网关派活失败：${rpcErr instanceof Error ? rpcErr.message : String(rpcErr)}`,
        });
        await maybeAutoRetry(task, get, set);
        release();
        return;
      }
    }

    // 3. 记录 execution（写 canonicalExecution）。
    await approvals.startTaskExecution(task.id, {
      sessionId,
      sessionKey,
      ...(resolvedAssigneeId ? { agentId: resolvedAssigneeId } : {}),
      ...(runId ? { entrySessionKey: sessionKey } : {}),
    });

    // 4. 落终态并写入真实产出，流转 review。
    //    - 真实执行：workResult = 模型真实产出（截断存储，避免过长）。
    //    - 网关回退：仍是“已派发执行”，真实产出由主干事件流后续推进。
    await approvals.updateTask(task.id, {
      status: 'review',
      workState: 'done',
      ...(deliverableDir ? { deliverableDir } : {}),
      workResult: realOutput
        ? realOutput.slice(0, 4000)
        : runId
          ? `已派发执行（runId=${runId}）`
          : '已派发执行',
    });
    attemptCount.delete(task.id); // 成功后清计数
    set({ note: realOutput ? `已完成：${task.title.slice(0, 24)}` : `已派发：${task.title.slice(0, 24)}` });
    // 系统通知：真实执行跑完进评审列，提醒用户验收（点击通知直达任务详情）
    if (realOutput) notifyTaskTerminal(task.id, 'done', task.title);
    release();
    void get()._tick(); // 立即补槽
  } catch (e) {
    // 兜底：任何异常都落 failed 并释放槽位，避免卡在 idle 反复领取。
    try {
      await approvals.updateTask(task.id, {
        workState: 'failed',
        workError: e instanceof Error ? e.message : String(e),
      });
      await maybeAutoRetry(task, get, set);
    } catch {
      /* 落库失败忽略 */
    }
    release();
  }
}

/**
 * S9 自动重试：若该任务尝试次数未达 maxAttempts，则把它复位为可重跑
 * （status='todo', workState='idle'），下一轮 tick 会再次领取；达上限则终止。
 */
async function maybeAutoRetry(
  task: KanbanTask,
  get: () => AutoWorkerState,
  set: (partial: Partial<AutoWorkerState>) => void,
): Promise<void> {
  const attempts = attemptCount.get(task.id) ?? 1;
  const max = get().maxAttempts;
  if (attempts >= max) {
    set({ note: `任务失败且已达重试上限（${attempts}/${max}），终止：${task.title.slice(0, 20)}` });
    attemptCount.delete(task.id);
    // 系统通知：终态失败（不再自动重试），提醒用户处理；原因从 store 取最新
    const freshError = useApprovalsStore.getState().tasks.find((t) => t.id === task.id)?.workError;
    notifyTaskTerminal(task.id, 'failed', task.title, freshError ?? undefined);
    return;
  }
  // 复位为待办，等待下一轮自动领取重跑。计数保留（下次进入 runOne 再 +1）。
  await useApprovalsStore.getState().updateTask(task.id, {
    status: 'todo',
    workState: 'idle',
  });
  set({ note: `失败自动重试：第 ${attempts + 1}/${max} 次已重排队：${task.title.slice(0, 20)}` });
}

/**
 * 仅供单测使用：重置 worker 的模块级运行期状态（重试计数、在途槽位、claim 集合）。
 * 生产代码不应调用。
 */
export function __resetAutoWorkerForTest(): void {
  attemptCount.clear();
  claimed.clear();
  inFlight = 0;
  ticking = false;
  realExecutorReady = false;
  realExecutorProbed = false;
  clearTimer();
}
