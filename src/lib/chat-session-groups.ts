/**
 * 会话页（/chats）左侧列表的分组逻辑（纯函数，便于单测）：
 * - 团队房间：所有团队都列出（teams store 兜底，sessions 里没有的标 missing，
 *   点击时由调用方 ensureTeamSession 再 switchSession）
 * - 任务会话：team-task: 条目，显示任务标题（tasks 查不到的已删任务显示 id 截断）
 * - Agent 会话：其余条目，用 resolveSessionDisplayLabel
 * 每组内按最近活跃倒序。
 */
import type { ChatSession } from '@/stores/chat';
import { resolveSessionDisplayLabel } from '@/lib/session-label';

export interface ChatSessionListItem {
  key: string;
  label: string;
  /** 最近活跃时间（ms），组内排序依据 */
  lastActivity: number;
  /** 仅团队房间：sessions 里还没有对应条目（teams 兜底出来的） */
  missing?: boolean;
}

export interface ChatSessionGroups {
  teamRooms: ChatSessionListItem[];
  taskSessions: ChatSessionListItem[];
  agentSessions: ChatSessionListItem[];
}

type TeamLike = { id: string; name: string };
type TaskLike = { id: string; title: string };
type AgentLike = { id: string; name: string };

export interface GroupChatSessionsOptions {
  tasks?: TaskLike[];
  agents?: AgentLike[];
  sessionLastActivity?: Record<string, number>;
}

function activityOf(
  session: ChatSession | undefined,
  key: string,
  sessionLastActivity: Record<string, number>,
): number {
  return sessionLastActivity[key] ?? session?.updatedAt ?? 0;
}

function byRecentActivityDesc(a: ChatSessionListItem, b: ChatSessionListItem): number {
  return b.lastActivity - a.lastActivity;
}

export function groupChatSessions(
  sessions: ChatSession[],
  teams: TeamLike[],
  options: GroupChatSessionsOptions = {},
): ChatSessionGroups {
  const tasks = options.tasks ?? [];
  const agents = options.agents ?? [];
  const sessionLastActivity = options.sessionLastActivity ?? {};

  const sessionByKey = new Map(sessions.map((s) => [s.key, s]));

  // 团队房间：以 teams 为准兜底，sessions 里多出来的（如团队已删）也列出
  const teamRooms: ChatSessionListItem[] = [];
  const roomKeys = new Set<string>();
  for (const team of teams) {
    const key = `team:${team.id}`;
    roomKeys.add(key);
    const existing = sessionByKey.get(key);
    teamRooms.push({
      key,
      label: team.name,
      lastActivity: activityOf(existing, key, sessionLastActivity),
      missing: !existing,
    });
  }
  for (const session of sessions) {
    if (!session.key.startsWith('team:') || roomKeys.has(session.key)) continue;
    if (session.teamTaskId) continue;
    teamRooms.push({
      key: session.key,
      label: session.displayName ?? session.key,
      lastActivity: activityOf(session, session.key, sessionLastActivity),
    });
  }

  // 任务会话：team-task: 前缀或带 teamTaskId 标记
  const taskSessions: ChatSessionListItem[] = [];
  for (const session of sessions) {
    const taskId = session.teamTaskId
      ?? (session.key.startsWith('team-task:') ? session.key.slice('team-task:'.length) : null);
    if (!taskId) continue;
    const task = tasks.find((t) => t.id === taskId);
    taskSessions.push({
      key: session.key,
      label: task ? task.title : `${taskId.slice(0, 8)}…`,
      lastActivity: activityOf(session, session.key, sessionLastActivity),
    });
  }

  // Agent 会话：其余条目
  const agentSessions: ChatSessionListItem[] = sessions
    .filter((s) => !s.key.startsWith('team:') && !s.key.startsWith('team-task:') && !s.teamTaskId)
    .map((session) => ({
      key: session.key,
      label: resolveSessionDisplayLabel(session, agents),
      lastActivity: activityOf(session, session.key, sessionLastActivity),
    }));

  return {
    teamRooms: teamRooms.sort(byRecentActivityDesc),
    taskSessions: taskSessions.sort(byRecentActivityDesc),
    agentSessions: agentSessions.sort(byRecentActivityDesc),
  };
}
