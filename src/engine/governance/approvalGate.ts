/**
 * 审批门与回滚执行器（高风险动作的治理执行面）
 * --------------------------------------------------------------------------
 * 此前的问题：`boss_review` 只产出 `{action, requiresHumanAck}` 这样的**决策标签**，
 * 没有任何代码消费它去真正拦住动作——高风险动作照样一路执行到底，
 * `action='rollback'` 也只是把 run.status 置成 failed，没有任何补偿动作。
 * 那不叫「审批与回滚」，那叫「审批与回滚的注释」。
 *
 * 本模块把它变成**可执行的治理门**：
 *
 *   1. 审批门（approval gate）
 *      高风险动作（requiresHumanAck=true）在执行前必须先落一条 PENDING 审批单，
 *      闭环在此**挂起**（run.status='awaiting_approval'），动作**不生效**。
 *      只有人类显式 approve 之后，动作才被执行（effect 真正 apply）。
 *      人类 reject → 动作永不执行，闭环以 'rejected' 终态收尾。
 *
 *   2. 回滚执行器（rollback executor）
 *      每个已执行的高风险动作都登记**补偿动作**（compensating action）。
 *      触发回滚时逐条逆序执行补偿，把系统恢复到动作发生前的状态，
 *      并留下 ROLLED_BACK 审计记录。回滚本身也进审计流水，不是静默撤销。
 *
 *   3. 审计流水（audit log）
 *      审批单从 PENDING → APPROVED/REJECTED/ROLLED_BACK 的每一次状态跃迁都追加
 *      一条不可变审计条目（who/what/when/why），可导出 JSONL 作为执行证据。
 *
 * 设计约束（与本项目其余模块一致）：
 *  - 纯逻辑、零 Electron/IPC 副作用，vitest 与 web demo 均可直接运行。
 *  - 持久化可插拔（内存 / localStorage / 未来 Electron JSONL 落盘）。
 *  - 失败不抛：补偿动作抛错时记录 failure 并继续执行其余补偿，不让一条坏补偿
 *    卡死整个回滚（半回滚状态会被如实记入审计，而不是假装成功）。
 *
 * 生产接线：本模块是引擎层的治理原语，既被引擎闭环（`demo/agentteams-adapter`
 * 的 `runTask`）调用，也通过 `recordHostApproval` 承接宿主运行时（Electron 主进程 /
 * 后端）驱动的生产审批决策，使生产审批同样拥有不可变审计流水与可导出证据。
 */

/** 审批单状态机：PENDING 为唯一初态，其余三个为终态。 */
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'rolled_back';

/** 风险等级（与 RoleCard.boundaries.riskLevel 对齐）。 */
export type RiskLevel = 'low' | 'medium' | 'high';

/** 一条审计记录（不可变，追加写）。 */
export interface AuditEntry {
  /** 状态跃迁到达的状态 */
  state: ApprovalState;
  /** 决策人（人类 id / 'system' / 'auto-policy'） */
  actor: string;
  /** 决策理由 */
  reason: string;
  ts: number;
}

/** 一张审批单。 */
export interface ApprovalRequest {
  approvalId: string;
  /** 关联的闭环 run */
  runId: string;
  /** 申请执行该动作的 Agent（角色卡 id） */
  requestedBy: string;
  /** 动作名（如 hire / reject / rollback） */
  action: string;
  /** 动作作用对象（候选 Agent id） */
  targetId: string;
  /** 人类可读的动作描述（审批界面展示） */
  summary: string;
  riskLevel: RiskLevel;
  state: ApprovalState;
  /** 完整状态跃迁审计流水 */
  audit: AuditEntry[];
  createdAt: number;
}

/** 高风险动作的执行体 + 补偿体（Saga 模式的最小形态）。 */
export interface GovernedAction<T = unknown> {
  /** 审批通过后真正执行的副作用 */
  apply: () => T | Promise<T>;
  /**
   * 补偿动作：把 apply 造成的副作用撤销。
   * 缺省表示该动作不可补偿——此时 rollback 会如实记录「不可补偿」而非假装成功。
   */
  compensate?: () => void | Promise<void>;
  /** 补偿动作的人类可读描述（进审计流水） */
  compensateDescription?: string;
}

/** 已执行动作的补偿登记项。 */
interface CompensationRecord {
  approvalId: string;
  runId: string;
  compensate?: () => void | Promise<void>;
  description: string;
}

/** 持久化后端（内存 / localStorage / Electron JSONL 均可实现）。 */
export interface ApprovalPersister {
  save(request: ApprovalRequest): void;
  get(approvalId: string): ApprovalRequest | null;
  list(): ApprovalRequest[];
  clear(): void;
}

export function createMemoryApprovalPersister(): ApprovalPersister {
  const store = new Map<string, ApprovalRequest>();
  return {
    save: (r) => void store.set(r.approvalId, r),
    get: (id) => store.get(id) ?? null,
    list: () => [...store.values()].sort((a, b) => a.createdAt - b.createdAt),
    clear: () => store.clear(),
  };
}

/** 浏览器 localStorage 后端（web demo 用；非浏览器环境降级内存）。 */
export function createLocalStorageApprovalPersister(
  storageKey = 'agentcorp-approvals',
): ApprovalPersister {
  const memory = createMemoryApprovalPersister();
  if (typeof localStorage === 'undefined') return memory;

  const readAll = (): ApprovalRequest[] => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ApprovalRequest[]) : [];
    } catch {
      return [];
    }
  };
  const writeAll = (list: ApprovalRequest[]): void => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(list));
    } catch {
      // 配额/隐私模式：审批单写入失败时退回内存，本次会话内语义不变
    }
  };

  return {
    save: (r) => {
      const list = readAll();
      const idx = list.findIndex((x) => x.approvalId === r.approvalId);
      if (idx >= 0) list[idx] = r;
      else list.push(r);
      writeAll(list);
      memory.save(r);
    },
    get: (id) => readAll().find((x) => x.approvalId === id) ?? memory.get(id),
    list: () => {
      const persisted = readAll();
      return persisted.length > 0
        ? persisted.sort((a, b) => a.createdAt - b.createdAt)
        : memory.list();
    },
    clear: () => {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // 清不掉不影响后续语义
      }
      memory.clear();
    },
  };
}

let persister: ApprovalPersister = createMemoryApprovalPersister();
/** 已执行动作的补偿登记表（approvalId → 补偿动作）。 */
const compensations = new Map<string, CompensationRecord>();

export function setApprovalPersister(p: ApprovalPersister): void {
  persister = p;
}

/** 提交结果：要么直接放行（低风险），要么挂起等待人工审批。 */
export type GateOutcome<T> =
  | { gated: false; executed: true; approvalId: string; result: T }
  | { gated: true; executed: false; approvalId: string; request: ApprovalRequest };

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 通过审批门执行一个动作。
 *
 * - `requiresApproval=false`（低风险）：立即执行，登记补偿，审批单直接落 approved
 *   （仍留审计记录——「自动放行」也是一次可审计的治理决策，不是无记录的空白）。
 * - `requiresApproval=true`（高风险）：**不执行**，落 PENDING 审批单并返回，
 *   由调用方把闭环置为挂起态，等待 `decideApproval` 显式放行。
 */
export async function submitForApproval<T>(input: {
  runId: string;
  requestedBy: string;
  action: string;
  targetId: string;
  summary: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  governed: GovernedAction<T>;
}): Promise<GateOutcome<T>> {
  const approvalId = newId('appr');
  const now = Date.now();

  const request: ApprovalRequest = {
    approvalId,
    runId: input.runId,
    requestedBy: input.requestedBy,
    action: input.action,
    targetId: input.targetId,
    summary: input.summary,
    riskLevel: input.riskLevel,
    state: 'pending',
    audit: [
      {
        state: 'pending',
        actor: input.requestedBy,
        reason: `申请执行高风险动作「${input.action}」：${input.summary}`,
        ts: now,
      },
    ],
    createdAt: now,
  };

  if (input.requiresApproval) {
    // 高风险：动作**不执行**，闭环在此挂起。这是「门」而非「标签」的关键。
    persister.save(request);
    return { gated: true, executed: false, approvalId, request };
  }

  // 低风险：自动放行，但仍登记补偿与审计（保证任何动作都可回滚、可追溯）
  const result = await input.governed.apply();
  compensations.set(approvalId, {
    approvalId,
    runId: input.runId,
    compensate: input.governed.compensate,
    description: input.governed.compensateDescription ?? '（未声明补偿动作）',
  });
  request.state = 'approved';
  request.audit.push({
    state: 'approved',
    actor: 'auto-policy',
    reason: `风险等级 ${input.riskLevel} 未达人工审批阈值，按策略自动放行并登记补偿。`,
    ts: Date.now(),
  });
  persister.save(request);
  return { gated: false, executed: true, approvalId, result };
}

/** 人工决策结果。 */
export interface DecisionOutcome<T = unknown> {
  ok: boolean;
  state: ApprovalState;
  reason: string;
  /** approve 且动作执行成功时携带执行结果 */
  result?: T;
}

/**
 * 人类对挂起的审批单做决策。
 *
 * approve → 此刻才真正执行动作并登记补偿；reject → 动作永不执行。
 * 非 pending 单重复决策会被拒绝（幂等保护，防止重复执行高风险动作）。
 */
export async function decideApproval<T = unknown>(
  approvalId: string,
  decision: 'approve' | 'reject',
  actor: string,
  reason: string,
  governed?: GovernedAction<T>,
): Promise<DecisionOutcome<T>> {
  const request = persister.get(approvalId);
  if (!request) {
    return { ok: false, state: 'pending', reason: `审批单不存在：${approvalId}` };
  }
  if (request.state !== 'pending') {
    // 幂等保护：已决策的单不可再次决策，避免「审批通过」被重放导致动作执行两次
    return {
      ok: false,
      state: request.state,
      reason: `审批单 ${approvalId} 已处于终态 ${request.state}，拒绝重复决策。`,
    };
  }

  if (decision === 'reject') {
    request.state = 'rejected';
    request.audit.push({ state: 'rejected', actor, reason, ts: Date.now() });
    persister.save(request);
    return { ok: true, state: 'rejected', reason };
  }

  // approve：此刻才执行动作
  let result: T | undefined;
  if (governed) {
    try {
      result = await governed.apply();
      compensations.set(approvalId, {
        approvalId,
        runId: request.runId,
        compensate: governed.compensate,
        description: governed.compensateDescription ?? '（未声明补偿动作）',
      });
    } catch (err) {
      // 执行失败如实记录，审批单不进 approved 终态（保持 pending 可重试）
      const msg = err instanceof Error ? err.message : String(err);
      request.audit.push({
        state: 'pending',
        actor,
        reason: `审批通过但动作执行失败：${msg}（审批单保持 pending 可重试）`,
        ts: Date.now(),
      });
      persister.save(request);
      return { ok: false, state: 'pending', reason: `动作执行失败：${msg}` };
    }
  }

  request.state = 'approved';
  request.audit.push({ state: 'approved', actor, reason, ts: Date.now() });
  persister.save(request);
  return { ok: true, state: 'approved', reason, result };
}

/** 回滚结果。 */
export interface RollbackOutcome {
  ok: boolean;
  /** 实际执行成功的补偿动作数 */
  compensated: number;
  /** 补偿失败的条目（半回滚状态如实暴露，不假装完全成功） */
  failures: Array<{ approvalId: string; error: string }>;
  /** 声明为不可补偿的动作（需人工介入） */
  uncompensable: string[];
  reason: string;
}

/**
 * 回滚一次 run 内所有已执行的高风险动作（逆序补偿）。
 *
 * 逆序是必须的：后执行的动作可能依赖先执行的动作，先撤后者才安全。
 * 单条补偿抛错不中断整体（其余补偿仍会尝试），失败条目如实进 failures，
 * 让「半回滚」这种真实存在的危险状态被看见，而不是被一个 try/catch 吞掉。
 */
export async function rollbackRun(
  runId: string,
  actor: string,
  reason: string,
): Promise<RollbackOutcome> {
  const targets = [...compensations.values()]
    .filter((c) => c.runId === runId)
    .reverse(); // 逆序补偿

  const failures: RollbackOutcome['failures'] = [];
  const uncompensable: string[] = [];
  let compensated = 0;

  for (const record of targets) {
    if (!record.compensate) {
      uncompensable.push(record.approvalId);
      continue;
    }
    try {
      await record.compensate();
      compensated += 1;
      compensations.delete(record.approvalId);

      const req = persister.get(record.approvalId);
      if (req) {
        req.state = 'rolled_back';
        req.audit.push({
          state: 'rolled_back',
          actor,
          reason: `${reason}｜已执行补偿：${record.description}`,
          ts: Date.now(),
        });
        persister.save(req);
      }
    } catch (err) {
      failures.push({
        approvalId: record.approvalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: failures.length === 0,
    compensated,
    failures,
    uncompensable,
    reason:
      failures.length === 0
        ? `回滚完成：补偿 ${compensated} 项${uncompensable.length ? `，${uncompensable.length} 项声明为不可补偿需人工介入` : ''}。`
        : `回滚部分失败：成功 ${compensated} 项，失败 ${failures.length} 项——系统处于半回滚状态，必须人工介入。`,
  };
}

/** 列出审批单（可按 run / 状态过滤），供审批看板与证据导出使用。 */
export function listApprovals(filter?: {
  runId?: string;
  state?: ApprovalState;
}): ApprovalRequest[] {
  return persister.list().filter((r) => {
    if (filter?.runId && r.runId !== filter.runId) return false;
    if (filter?.state && r.state !== filter.state) return false;
    return true;
  });
}

export function getApproval(approvalId: string): ApprovalRequest | null {
  return persister.get(approvalId);
}

/**
 * 导出审计流水为 JSONL（执行证据沉淀）。
 * 每行一条状态跃迁，含审批单元信息，可直接作为合规审计材料。
 */
export function exportAuditJsonl(runId?: string): string[] {
  const lines: string[] = [];
  for (const req of listApprovals(runId ? { runId } : undefined)) {
    for (const entry of req.audit) {
      lines.push(
        JSON.stringify({
          approvalId: req.approvalId,
          runId: req.runId,
          action: req.action,
          targetId: req.targetId,
          riskLevel: req.riskLevel,
          requestedBy: req.requestedBy,
          ...entry,
        }),
      );
    }
  }
  return lines;
}

/**
 * 把宿主运行时（Electron 主进程 / 后端，见 stores/approvals.ts）驱动的审批决策
 * 登记进引擎治理原语，使生产审批同样拥有不可变审计流水与可导出证据
 * （exportAuditJsonl）。
 *
 * 不替代后端作为审批状态的权威源——后端仍是 pending/终态的真相源；本函数只补充
 * 客户端侧的治理审计，让生产环境的每一条人工 approve/reject 都可被导出为证据。
 *
 * 若同一 approvalId 的审批单已存在（如引擎闭环先 submit 再由宿主确认），
 * 则在其上追加终态审计条目，保持审计链连续。
 */
export function recordHostApproval(input: {
  approvalId: string;
  runId?: string;
  action: string;
  targetId: string;
  requestedBy: string;
  riskLevel?: RiskLevel;
  decision: 'approve' | 'reject';
  actor: string;
  reason: string;
}): ApprovalRequest {
  const now = Date.now();
  const terminal: ApprovalState = input.decision === 'approve' ? 'approved' : 'rejected';
  const existing = persister.get(input.approvalId);

  if (existing) {
    existing.state = terminal;
    existing.audit.push({ state: terminal, actor: input.actor, reason: input.reason, ts: now });
    persister.save(existing);
    return existing;
  }

  const request: ApprovalRequest = {
    approvalId: input.approvalId,
    runId: input.runId ?? input.approvalId,
    requestedBy: input.requestedBy,
    action: input.action,
    targetId: input.targetId,
    summary: input.reason,
    riskLevel: input.riskLevel ?? 'high',
    state: terminal,
    audit: [
      {
        state: 'pending',
        actor: input.requestedBy,
        reason: '宿主运行时提交审批（pending 态由后端持有为权威源）',
        ts: now,
      },
      { state: terminal, actor: input.actor, reason: input.reason, ts: now },
    ],
    createdAt: now,
  };
  persister.save(request);
  return request;
}

/** 清空（仅测试/演示重置用）。 */
export function resetApprovals(): void {
  persister.clear();
  compensations.clear();
}
