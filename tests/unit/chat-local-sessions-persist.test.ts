// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isLocalOnlySessionKey, useChatStore } from '@/stores/chat';

const LOCAL_SESSIONS_KEY = 'agentcorp:local-sessions';
const PREV_KEY = 'agent:main:main';

function resetStore() {
  useChatStore.setState({
    sessions: [],
    messages: [],
    sessionLabels: {},
    sessionLastActivity: {},
    currentSessionKey: PREV_KEY,
    error: null,
    // openTeamTaskSession → switchSession → loadHistory 会打网关，测试里换成空操作
    loadHistory: async () => {},
  } as never);
}

function readPersisted(): Array<{ key: string }> {
  const raw = localStorage.getItem(LOCAL_SESSIONS_KEY);
  return raw ? (JSON.parse(raw) as Array<{ key: string }>) : [];
}

describe('isLocalOnlySessionKey', () => {
  it('识别团队房间 / 任务会话 / 私聊', () => {
    expect(isLocalOnlySessionKey('team:t1')).toBe(true);
    expect(isLocalOnlySessionKey('team-task:task-1')).toBe(true);
    expect(isLocalOnlySessionKey('agent:a1:private-a1')).toBe(true);
  });

  it('网关会话不是本地专属', () => {
    expect(isLocalOnlySessionKey('agent:main:main')).toBe(false);
    expect(isLocalOnlySessionKey('agent:main:session-123')).toBe(false);
  });
});

describe('本地专属会话持久化（刷新不丢入口）', () => {
  beforeEach(() => {
    localStorage.removeItem(LOCAL_SESSIONS_KEY);
    resetStore();
  });

  it('ensureTeamSession / ensureTeamTaskSession 落盘', () => {
    useChatStore.getState().ensureTeamSession({ id: 't1', name: '马斯克团队' });
    useChatStore.getState().ensureTeamTaskSession({ id: 'task-1', title: '做一个计算器', teamId: 't1' });

    const keys = readPersisted().map((s) => s.key);
    expect(keys).toContain('team:t1');
    expect(keys).toContain('team-task:task-1');
  });

  it('模拟刷新：从 localStorage 恢复为初始 sessions', async () => {
    localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify([
      { key: 'team:t1', displayName: '马斯克团队', isTeamSession: true, teamId: 't1', updatedAt: 123 },
      { key: 'team-task:task-1', displayName: '团队任务 · 做一个计算器', isTeamSession: true, teamTaskId: 'task-1' },
      // 非本地 key 即使混进来也会被过滤
      { key: 'agent:main:session-1', displayName: '不应恢复' },
    ]));

    vi.resetModules();
    const fresh = await import('@/stores/chat');
    const keys = fresh.useChatStore.getState().sessions.map((s) => s.key);
    expect(keys).toEqual(['team:t1', 'team-task:task-1']);
    expect(fresh.useChatStore.getState().sessions[0].displayName).toBe('马斯克团队');
  });

  it('localStorage 损坏时静默回退为空列表', async () => {
    localStorage.setItem(LOCAL_SESSIONS_KEY, '{not json');

    vi.resetModules();
    const fresh = await import('@/stores/chat');
    expect(fresh.useChatStore.getState().sessions).toEqual([]);
  });

  it('deleteSession 同步从落盘数据中移除', async () => {
    useChatStore.getState().ensureTeamSession({ id: 't1', name: '马斯克团队' });
    expect(readPersisted().map((s) => s.key)).toContain('team:t1');

    // deleteSession 会调 hostApiFetch（Electron IPC），测试环境里没有，静默失败即可
    await useChatStore.getState().deleteSession('team:t1').catch(() => {});

    expect(useChatStore.getState().sessions.find((s) => s.key === 'team:t1')).toBeUndefined();
    expect(readPersisted().map((s) => s.key)).not.toContain('team:t1');
  });
});

describe('空会话修剪不删结构性本地会话', () => {
  beforeEach(() => {
    localStorage.removeItem(LOCAL_SESSIONS_KEY);
    resetStore();
  });

  it('cleanupEmptySession 保留空消息的团队任务会话', () => {
    const key = useChatStore.getState().ensureTeamTaskSession({ id: 'task-1', title: '做一个计算器' });
    useChatStore.setState({ currentSessionKey: key, messages: [] } as never);

    useChatStore.getState().cleanupEmptySession();

    expect(useChatStore.getState().sessions.find((s) => s.key === key)).toBeDefined();
  });

  it('cleanupEmptySession 仍清理空的普通网关会话', () => {
    useChatStore.setState({
      sessions: [{ key: 'agent:main:session-9', displayName: 'ghost' }],
      currentSessionKey: 'agent:main:session-9',
      messages: [],
    } as never);

    useChatStore.getState().cleanupEmptySession();

    expect(useChatStore.getState().sessions.find((s) => s.key === 'agent:main:session-9')).toBeUndefined();
  });

  it('newSession 切走时不删空的团队房间', () => {
    const key = useChatStore.getState().ensureTeamSession({ id: 't1', name: '马斯克团队' });
    useChatStore.setState({ currentSessionKey: key, messages: [] } as never);

    useChatStore.getState().newSession();

    expect(useChatStore.getState().sessions.find((s) => s.key === key)).toBeDefined();
  });
});
