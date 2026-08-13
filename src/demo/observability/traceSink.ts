/**
 * Demo 闭环 Trace 落盘 + 回放（GOAI 要求 4 可观测 · SP-10）
 * --------------------------------------------------------------------------
 * Electron 侧的 A2A 委派 trace 由 `electron/services/evaluation/a2a-trace.ts`
 * 落盘（~/.openclaw/a2a-traces/*.jsonl）；本模块补齐 **web demo 闭环**这条链路：
 * 一次 `ATRun` 序列化为 JSONL（meta + 每步一行 + result 摘要一行），
 * 可回放还原为 ATRun——评审 PPT 的 Trace 证据即来源于此。
 *
 * 字段对齐说明（SP-11 前置）：本模块 JSONL 与 a2a-trace.ts 的 A2aTraceRecord
 * 是两条 Trace 链路的同级证据，字段映射为——
 *   runId ↔ trace_id（根关联）  agent ↔ delegatee   status ↔ state
 *   steps[].summary ↔ summary   steps[].skill ↔ skill（A2A 侧为 tool 维度）
 * 两者均可经 `otelGenai.ts` 投影为 OTel GenAI span（gen_ai.* 字段）。
 *
 * 存储可插拔：默认内存（vitest）；web demo 注入 localStorage 后端；
 * 「保存本次 Trace」按钮另提供 .jsonl 文件下载（浏览器环境等价落盘）。
 */
import type { ATRun } from '../agentteams-adapter';
import type { ClosedLoopResult } from '../closedLoop';

/** Trace 存储后端（内存 / localStorage / 未来 Electron 文件系统均可实现）。 */
export interface TraceBackend {
  write(id: string, lines: string[]): void;
  read(id: string): string[] | null;
  list(): string[];
  clear(): void;
}

export function createMemoryTraceBackend(): TraceBackend {
  const store = new Map<string, string[]>();
  return {
    write: (id, lines) => void store.set(id, lines),
    read: (id) => store.get(id) ?? null,
    list: () => [...store.keys()].sort(),
    clear: () => store.clear(),
  };
}

/** web demo 用：localStorage 后端（key 前缀 agentcorp-trace:）。 */
export function createLocalStorageBackend(): TraceBackend {
  const PREFIX = 'agentcorp-trace:';
  const available = typeof localStorage !== 'undefined';
  const memory = createMemoryTraceBackend(); // 非浏览器环境降级内存
  if (!available) return memory;
  return {
    write: (id, lines) => {
      try {
        localStorage.setItem(PREFIX + id, JSON.stringify(lines));
      } catch {
        // 隐私模式/配额超限：trace 是旁路证据，写入失败不影响主流程
      }
    },
    read: (id) => {
      try {
        const raw = localStorage.getItem(PREFIX + id);
        return raw ? (JSON.parse(raw) as string[]) : null;
      } catch {
        return null; // 存储损坏按「无此 trace」处理
      }
    },
    list: () =>
      Object.keys(localStorage)
        .filter((k) => k.startsWith(PREFIX))
        .map((k) => k.slice(PREFIX.length))
        .sort(),
    clear: () => {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(PREFIX)) localStorage.removeItem(k);
      }
    },
  };
}

let backend: TraceBackend = createMemoryTraceBackend();

export function setTraceBackend(b: TraceBackend): void {
  backend = b;
}

/* ───────────── 序列化（ATRun → JSONL 行） ───────────── */

interface TraceMetaLine {
  kind: 'meta';
  runId: string;
  teamId: string;
  taskId: string;
  status: ATRun['status'];
  ts: number;
}
interface TraceStepLine {
  kind: 'step';
  phase: string;
  agent: string;
  skill?: string;
  summary: string;
  status: 'ok' | 'warn' | 'blocked';
}
/** 落盘形态的 result：request.judge（注入函数）不可序列化，已显式剔除。 */
type SerializedResult = Omit<ClosedLoopResult, 'request'> & {
  request: Omit<ClosedLoopResult['request'], 'judge'>;
};
interface TraceResultLine {
  kind: 'result';
  result: SerializedResult;
}
type TraceLine = TraceMetaLine | TraceStepLine | TraceResultLine;

/** ATRun → JSONL 行序列（meta 一行 + 每步一行 + result 一行）。 */
export function serializeRun(run: ATRun): string[] {
  const meta: TraceMetaLine = {
    kind: 'meta',
    runId: run.runId,
    teamId: run.teamId,
    taskId: run.taskId,
    status: run.status,
    ts: Date.now(),
  };
  const steps: TraceStepLine[] = run.steps.map((s) => ({ kind: 'step', ...s }));
  const lines: TraceLine[] = [meta, ...steps];
  if (run.result) {
    // request.judge 是注入函数，JSON 序列化会静默丢弃——显式剔除并标注，
    // 避免回放方误以为 request 完整还原（M4）。
    const { judge: _judgeStripped, ...requestRest } = run.result.request;
    lines.push({ kind: 'result', result: { ...run.result, request: requestRest } });
  }
  return lines.map((l) => JSON.stringify(l));
}

/** JSONL 行序列 → ATRun（round-trip 还原；损坏行跳过并计数，不整体崩）。 */
export function deserializeRun(lines: string[]): ATRun {
  let meta: TraceMetaLine | null = null;
  const steps: ATRun['steps'] = [];
  let result: ClosedLoopResult | undefined;
  let skipped = 0;
  for (const raw of lines) {
    let line: TraceLine;
    try {
      line = JSON.parse(raw) as TraceLine;
    } catch {
      skipped += 1; // 单行损坏不阻断回放（trace 是旁路证据）
      continue;
    }
    if (line.kind === 'meta') meta = line;
    else if (line.kind === 'step') {
      const { kind: _k, ...step } = line;
      steps.push(step);
    } else if (line.kind === 'result') {
      // judge 函数不落盘（见 serializeRun），回放方如需重跑须重新注入评委
      result = line.result as unknown as ClosedLoopResult;
    }
  }
  if (!meta) throw new Error('trace 缺少 meta 行，无法回放');
  if (skipped > 0) {
    console.warn(`[traceSink] 回放跳过 ${skipped} 行损坏记录`);
  }
  return {
    runId: meta.runId,
    teamId: meta.teamId,
    taskId: meta.taskId,
    status: meta.status,
    steps,
    result,
  };
}

/* ───────────── 落盘 / 回放 ───────────── */

/** 把一次 run 落盘（JSONL），返回 trace id（= runId）。 */
export function sinkRun(run: ATRun, b: TraceBackend = backend): string {
  b.write(run.runId, serializeRun(run));
  return run.runId;
}

/** 按 id 回放历史 run（round-trip 还原步骤与决策）。 */
export function replayRun(id: string, b: TraceBackend = backend): ATRun | null {
  const lines = b.read(id);
  return lines ? deserializeRun(lines) : null;
}

/** 列出全部已落盘 trace id。 */
export function listRunIds(b: TraceBackend = backend): string[] {
  return b.list();
}

/** 浏览器环境「保存本次 Trace」：触发 run-<id>.jsonl 文件下载。 */
export function downloadRunJsonl(run: ATRun): void {
  if (typeof document === 'undefined') return; // 非浏览器环境静默跳过
  const blob = new Blob([serializeRun(run).join('\n') + '\n'], {
    type: 'application/x-ndjson',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `run-${run.runId}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
}
