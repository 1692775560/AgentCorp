/**
 * src/lib/a2a-timeline.ts
 * 看板任务详情的 A2A 协作时间线解析（纯函数，供 UI 渲染与单测）。
 *
 * A2A 事件格式（autoWorker.traceToEvent 产出）：
 *   type    = `a2a:<delegator> → <delegatee>`
 *   content = `【第N轮】<summary>`，summary 里可能含 PASS / REWORK 字样
 */
import type { TaskExecutionEvent } from '@/types/task';

/** 从事件 type 解析 A2A 路由；非 A2A 事件返回 null。 */
export function parseA2aRoute(type: string | undefined): { from: string; to: string } | null {
  if (!type || !type.startsWith('a2a:')) return null;
  const route = type.slice(4);
  const sep = route.indexOf('→');
  if (sep === -1) return { from: route.trim(), to: '' };
  return { from: route.slice(0, sep).trim(), to: route.slice(sep + 1).trim() };
}

/** 参与协作的 agent id 列表（按首次出现顺序，delegator 与 delegatee 都算）。 */
export function extractA2aParticipants(events: TaskExecutionEvent[]): string[] {
  const seen: string[] = [];
  for (const e of events) {
    const route = parseA2aRoute(e.type);
    if (!route) continue;
    for (const id of [route.from, route.to]) {
      if (id && !seen.includes(id)) seen.push(id);
    }
  }
  return seen;
}

export interface A2aStats {
  /** 最大轮次号（没有轮次信息时为 0） */
  rounds: number;
  /** 含 PASS 的事件数 */
  pass: number;
  /** 含 REWORK 的事件数 */
  rework: number;
  /** A2A 事件总数 */
  total: number;
}

/** 汇总协作统计：轮次、通过、返工。 */
export function summarizeA2aEvents(events: TaskExecutionEvent[]): A2aStats {
  let rounds = 0;
  let pass = 0;
  let rework = 0;
  let total = 0;
  for (const e of events) {
    if (!parseA2aRoute(e.type)) continue;
    total += 1;
    const m = /【第(\d+)轮】/.exec(e.content ?? '');
    if (m) rounds = Math.max(rounds, Number(m[1]));
    if (e.content?.includes('PASS')) pass += 1;
    if (e.content?.includes('REWORK')) rework += 1;
  }
  return { rounds, pass, rework, total };
}
