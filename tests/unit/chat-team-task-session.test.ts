import { beforeEach, describe, expect, it } from 'vitest';

import { useChatStore } from '@/stores/chat';

const TASK = { id: 'task-1', title: '做一个计算器', teamId: 'team-1', teamName: '交付一组' };
const PREV_KEY = 'agent:main:main';

function resetStore() {
  useChatStore.setState({
    sessions: [],
    sessionLabels: {},
    sessionLastActivity: {},
    currentSessionKey: PREV_KEY,
    error: null,
    // openTeamTaskSession → switchSession → loadHistory 会打网关，测试里换成空操作
    loadHistory: async () => {},
  } as never);
}

describe('团队任务会话', () => {
  beforeEach(() => {
    resetStore();
  });

  it('ensureTeamTaskSession 建条目但不切换当前会话', () => {
    const key = useChatStore.getState().ensureTeamTaskSession(TASK);

    expect(key).toBe('team-task:task-1');
    const state = useChatStore.getState();
    const session = state.sessions.find((s) => s.key === key);
    expect(session).toBeDefined();
    expect(session?.teamTaskId).toBe('task-1');
    expect(session?.isTeamSession).toBe(true);
    expect(session?.displayName).toBe('团队任务 · 做一个计算器');
    expect(state.sessionLabels[key]).toBe('团队任务 · 做一个计算器');
    expect(state.currentSessionKey).toBe(PREV_KEY);
  });

  it('ensureTeamTaskSession 幂等：重复调用不产生重复条目', () => {
    useChatStore.getState().ensureTeamTaskSession(TASK);
    useChatStore.getState().ensureTeamTaskSession(TASK);

    expect(useChatStore.getState().sessions.filter((s) => s.key === 'team-task:task-1')).toHaveLength(1);
  });

  it('openTeamTaskSession 建条目并切换为当前会话', () => {
    const key = useChatStore.getState().openTeamTaskSession(TASK);

    expect(useChatStore.getState().currentSessionKey).toBe(key);
  });

  it('不带团队元信息时也能建条目', () => {
    const key = useChatStore.getState().ensureTeamTaskSession({ id: 'task-2', title: '无团队任务' });
    const session = useChatStore.getState().sessions.find((s) => s.key === key);
    expect(session?.teamId).toBeUndefined();
    expect(session?.displayName).toBe('团队任务 · 无团队任务');
  });
});


describe('团队房间会话', () => {
  const TEAM = { id: 'team-1', name: '马斯克团队' };

  beforeEach(() => {
    resetStore();
  });

  it('ensureTeamSession 建房间条目，不带 teamTaskId（区别于任务会话）', () => {
    const key = useChatStore.getState().ensureTeamSession(TEAM);

    expect(key).toBe('team:team-1');
    const session = useChatStore.getState().sessions.find((s) => s.key === key);
    expect(session?.isTeamSession).toBe(true);
    expect(session?.teamId).toBe('team-1');
    expect(session?.teamTaskId).toBeUndefined();
    expect(session?.displayName).toBe('马斯克团队');
    // 不切换当前会话
    expect(useChatStore.getState().currentSessionKey).toBe(PREV_KEY);
  });

  it('幂等；团队改名时同步显示名', () => {
    useChatStore.getState().ensureTeamSession(TEAM);
    useChatStore.getState().ensureTeamSession(TEAM);
    expect(useChatStore.getState().sessions.filter((s) => s.key === 'team:team-1')).toHaveLength(1);

    useChatStore.getState().ensureTeamSession({ id: 'team-1', name: '火星团队' });
    const session = useChatStore.getState().sessions.find((s) => s.key === 'team:team-1');
    expect(session?.displayName).toBe('火星团队');
    expect(useChatStore.getState().sessionLabels['team:team-1']).toBe('火星团队');
  });

  it('openTeamSession 建条目并切换为当前会话', () => {
    const key = useChatStore.getState().openTeamSession(TEAM);
    expect(useChatStore.getState().currentSessionKey).toBe(key);
  });
});
