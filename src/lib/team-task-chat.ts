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
  kind: 'a2a' | 'system';
  /** 发言者 agentId（system 气泡为空） */
  actorId: string;
  /** 协作对端（审阅时是 leader，执行时是 leader；供「回复给谁」展示） */
  peerId: string;
  text: string;
  round: number | null;
  verdict: 'pass' | 'rework' | null;
  createdAt?: string;
}

export function mapEventsToTeamChatBubbles(events: TaskExecutionEvent[]): TeamChatBubble[] {
  return events.map((e, i) => {
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
