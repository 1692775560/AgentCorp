/**
 * Chats Page — 独立「会话」页
 * 左侧 w-72 全高会话列表（分组：团队房间 / 任务会话 / Agent 会话），
 * 右侧复用 ChatMainArea 渲染对应会话的完整聊天区。
 * 团队房间由 teams store 兜底列出，点击时 ensureTeamSession 再 switchSession。
 */
import { useEffect, useMemo } from 'react';
import { ClipboardList, MessageSquare, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ChatMainArea } from '@/components/chat/ChatMainArea';
import { groupChatSessions, type ChatSessionListItem } from '@/lib/chat-session-groups';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/stores/agents';
import { useApprovalsStore } from '@/stores/approvals';
import { useChatStore } from '@/stores/chat';
import { useTeamsStore } from '@/stores/teams';

function SessionRow({
  item,
  active,
  onClick,
}: {
  item: ChatSessionListItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] transition-colors',
        active
          ? 'bg-[#FFD233]/30 font-semibold text-[#1A1C1E]'
          : 'text-[var(--neu-ink)] hover:bg-white',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
    </button>
  );
}

function SessionGroup({
  icon: Icon,
  title,
  items,
  currentSessionKey,
  onSelect,
}: {
  icon: typeof Users;
  title: string;
  items: ChatSessionListItem[];
  currentSessionKey: string;
  onSelect: (item: ChatSessionListItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="px-3 pb-2">
      <div className="flex items-center gap-1.5 px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--neu-ink-soft)]">
        <Icon className="h-3.5 w-3.5" />
        <span>{title}</span>
      </div>
      <div className="space-y-0.5">
        {items.map((item) => (
          <SessionRow
            key={item.key}
            item={item}
            active={item.key === currentSessionKey}
            onClick={() => onSelect(item)}
          />
        ))}
      </div>
    </div>
  );
}

export function Chats() {
  const { t } = useTranslation();
  const tChats = (key: string, defaultValue: string) =>
    t(`common:chatsPage.${key}`, { defaultValue });

  const sessions = useChatStore((s) => s.sessions);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessionLastActivity = useChatStore((s) => s.sessionLastActivity);
  const switchSession = useChatStore((s) => s.switchSession);

  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const teams = useTeamsStore((s) => s.teams);
  const fetchTeams = useTeamsStore((s) => s.fetchTeams);
  const tasks = useApprovalsStore((s) => s.tasks);
  const fetchTasks = useApprovalsStore((s) => s.fetchTasks);

  useEffect(() => {
    void fetchAgents();
    void fetchTeams();
    void fetchTasks();
  }, [fetchAgents, fetchTeams, fetchTasks]);

  // 团队房间：为每个团队确保一条会话条目（与首页同款兜底 effect）
  useEffect(() => {
    const ensure = useChatStore.getState().ensureTeamSession;
    teams.forEach((team) => ensure({ id: team.id, name: team.name }));
  }, [teams]);

  const groups = useMemo(
    () => groupChatSessions(sessions, teams, { tasks, agents, sessionLastActivity }),
    [sessions, teams, tasks, agents, sessionLastActivity],
  );

  const currentSession = sessions.find((s) => s.key === currentSessionKey) ?? null;
  const currentTeamTaskId = currentSession?.teamTaskId ?? null;
  const currentTeamRoomId = currentSession?.isTeamSession && !currentTeamTaskId
    ? currentSession.teamId ?? null
    : null;

  const handleSelect = (item: ChatSessionListItem) => {
    if (item.missing) {
      // teams 兜底出来的房间：先 ensure 再切换
      const team = teams.find((t2) => `team:${t2.id}` === item.key);
      if (team) {
        useChatStore.getState().ensureTeamSession({ id: team.id, name: team.name });
      }
    }
    switchSession(item.key);
  };

  return (
    <div className="relative flex h-full min-h-0 bg-white dark:bg-background">
      <aside className="flex h-full w-72 shrink-0 flex-col border-r border-black/[0.06] bg-[var(--neu-surface)]">
        <div className="flex h-[52px] shrink-0 items-center px-5">
          <h1 className="text-[15px] font-semibold text-foreground">{tChats('title', '会话')}</h1>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          <SessionGroup
            icon={Users}
            title={tChats('teamRooms', '团队房间')}
            items={groups.teamRooms}
            currentSessionKey={currentSessionKey}
            onSelect={handleSelect}
          />
          <SessionGroup
            icon={ClipboardList}
            title={tChats('taskSessions', '任务会话')}
            items={groups.taskSessions}
            currentSessionKey={currentSessionKey}
            onSelect={handleSelect}
          />
          <SessionGroup
            icon={MessageSquare}
            title={tChats('agentSessions', 'Agent 会话')}
            items={groups.agentSessions}
            currentSessionKey={currentSessionKey}
            onSelect={handleSelect}
          />
          {groups.teamRooms.length + groups.taskSessions.length + groups.agentSessions.length === 0 && (
            <p className="px-5 py-4 text-[13px] text-[var(--neu-ink-soft)]">
              {tChats('empty', '暂无会话')}
            </p>
          )}
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <ChatMainArea
          variant={currentTeamTaskId ? 'teamTask' : currentTeamRoomId ? 'teamRoom' : 'agent'}
          taskId={currentTeamTaskId}
          teamId={currentTeamRoomId}
        />
      </div>
    </div>
  );
}

export default Chats;
