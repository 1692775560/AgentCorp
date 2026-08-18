import { describe, expect, it } from 'vitest';

import { groupChatSessions } from '@/lib/chat-session-groups';
import type { ChatSession } from '@/stores/chat';

const TEAMS = [
  { id: 'team-1', name: '阿尔法战队' },
  { id: 'team-2', name: '贝塔小队' },
];

const TASKS = [
  { id: 'task-1', title: '写季度总结' },
];

const AGENTS = [
  { id: 'main', name: '总管' },
  { id: 'pm', name: '产品经理' },
];

describe('groupChatSessions', () => {
  it('团队房间：teams 兜底——sessions 没有的团队也列出并标 missing', () => {
    const sessions: ChatSession[] = [
      { key: 'team:team-1', displayName: '阿尔法战队', isTeamSession: true, teamId: 'team-1', updatedAt: 100 },
    ];
    const groups = groupChatSessions(sessions, TEAMS);

    expect(groups.teamRooms).toHaveLength(2);
    const room1 = groups.teamRooms.find((i) => i.key === 'team:team-1');
    const room2 = groups.teamRooms.find((i) => i.key === 'team:team-2');
    expect(room1?.label).toBe('阿尔法战队');
    expect(room1?.missing).toBe(false);
    expect(room2?.label).toBe('贝塔小队');
    expect(room2?.missing).toBe(true);
    expect(room2?.lastActivity).toBe(0);
  });

  it('团队房间：sessions 里多出的 team: 条目（团队已删）仍列出', () => {
    const sessions: ChatSession[] = [
      { key: 'team:gone', displayName: '已解散团队', isTeamSession: true, teamId: 'gone', updatedAt: 50 },
    ];
    const groups = groupChatSessions(sessions, TEAMS);
    const orphan = groups.teamRooms.find((i) => i.key === 'team:gone');
    expect(orphan?.label).toBe('已解散团队');
    expect(groups.teamRooms).toHaveLength(3);
  });

  it('任务会话：显示任务标题；已删任务显示 id 截断', () => {
    const sessions: ChatSession[] = [
      { key: 'team-task:task-1', isTeamSession: true, teamTaskId: 'task-1', updatedAt: 10 },
      { key: 'team-task:task-deleted-123', isTeamSession: true, teamTaskId: 'task-deleted-123', updatedAt: 20 },
    ];
    const groups = groupChatSessions(sessions, [], { tasks: TASKS });

    expect(groups.taskSessions).toHaveLength(2);
    expect(groups.taskSessions.find((i) => i.key === 'team-task:task-1')?.label).toBe('写季度总结');
    expect(groups.taskSessions.find((i) => i.key === 'team-task:task-deleted-123')?.label).toBe('task-del…');
    // 任务会话不应落入其他组
    expect(groups.agentSessions).toHaveLength(0);
    expect(groups.teamRooms).toHaveLength(0);
  });

  it('Agent 会话：其余条目用 resolveSessionDisplayLabel 解析', () => {
    const sessions: ChatSession[] = [
      { key: 'agent:main:session-1', updatedAt: 5 },
      { key: 'agent:pm:private-pm', isPrivateChat: true, targetAgentId: 'pm', updatedAt: 6 },
      { key: 'agent:unknown:session-9', updatedAt: 7 },
    ];
    const groups = groupChatSessions(sessions, [], { agents: AGENTS });

    expect(groups.agentSessions).toHaveLength(3);
    expect(groups.agentSessions.find((i) => i.key === 'agent:main:session-1')?.label).toBe('总管');
    expect(groups.agentSessions.find((i) => i.key === 'agent:pm:private-pm')?.label).toBe('产品经理');
    // 未匹配 agent 用兜底名
    expect(groups.agentSessions.find((i) => i.key === 'agent:unknown:session-9')?.label).toBe('AgentCorp');
  });

  it('组内按最近活跃倒序（sessionLastActivity 优先于 updatedAt）', () => {
    const sessions: ChatSession[] = [
      { key: 'agent:main:session-old', updatedAt: 100 },
      { key: 'agent:main:session-new', updatedAt: 200 },
      { key: 'team-task:task-1', teamTaskId: 'task-1', updatedAt: 1 },
      { key: 'team:team-1', isTeamSession: true, teamId: 'team-1', updatedAt: 1 },
    ];
    const groups = groupChatSessions(sessions, TEAMS, {
      tasks: TASKS,
      agents: AGENTS,
      sessionLastActivity: {
        'agent:main:session-old': 9999,
        'team-task:task-1': 500,
        'team:team-1': 300,
      },
    });

    expect(groups.agentSessions.map((i) => i.key)).toEqual([
      'agent:main:session-old',
      'agent:main:session-new',
    ]);
    // team-1（300）排在兜底的 team-2（0）之前
    expect(groups.teamRooms.map((i) => i.key)).toEqual(['team:team-1', 'team:team-2']);
    expect(groups.taskSessions[0].lastActivity).toBe(500);
  });

  it('空输入：全部团队兜底列出，其余组为空', () => {
    const groups = groupChatSessions([], TEAMS);
    expect(groups.teamRooms.map((i) => i.key)).toEqual(['team:team-1', 'team:team-2']);
    expect(groups.teamRooms.every((i) => i.missing)).toBe(true);
    expect(groups.taskSessions).toEqual([]);
    expect(groups.agentSessions).toEqual([]);
  });
});
