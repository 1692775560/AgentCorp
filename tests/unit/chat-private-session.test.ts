import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';

// 私聊会话应与成员主会话完全隔离：历史/发送都以 agent:X:private-X 直连网关，
// 不再映射回 agent:X:main（修复前 getEffectiveSessionKey 的串台行为）。
const AGENT = {
  id: 'pm',
  name: '产品经理',
  mainSessionKey: 'agent:pm:main',
  teamRole: 'member',
};
const MAIN_KEY = 'agent:pm:main';
const PRIVATE_KEY = 'agent:pm:private-pm';

const rpcMock = vi.fn<(method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>>();

function resetStore() {
  useAgentsStore.setState({ agents: [AGENT] } as never);
  useChatStore.setState({
    sessions: [],
    sessionLabels: {},
    sessionLastActivity: {},
    messages: [],
    currentSessionKey: 'agent:main:main',
    currentAgentId: 'main',
    sending: false,
    activeRunId: null,
    error: null,
    loading: false,
    streamingText: '',
    streamingMessage: null,
    pendingFinal: false,
    lastUserMessageAt: null,
  } as never);
}

// switchSession 触发的 loadHistory 是 fire-and-forget，等一拍让它落定，避免跨用例串扰
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function sessionKeysCalledWith(method: string): string[] {
  return rpcMock.mock.calls
    .filter(([m]) => m === method)
    .map(([, params]) => String((params as { sessionKey?: string })?.sessionKey ?? ''));
}

describe('成员私聊会话隔离', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ messages: [] });
    useGatewayStore.setState({ rpc: rpcMock } as never);
    resetStore();
  });

  afterEach(async () => {
    await flush();
  });

  it('openDirectAgentSession 打开私聊会话（agent:X:private-X），不是主会话', async () => {
    const key = useChatStore.getState().openDirectAgentSession('pm', { teamId: 'team-1' });

    expect(key).toBe(PRIVATE_KEY);
    expect(key).not.toBe(MAIN_KEY);
    expect(useChatStore.getState().currentSessionKey).toBe(PRIVATE_KEY);

    const session = useChatStore.getState().sessions.find((s) => s.key === PRIVATE_KEY);
    expect(session?.isPrivateChat).toBe(true);
    expect(session?.targetAgentId).toBe('pm');
    await flush();
  });

  it('loadHistory 用私聊 key 请求网关，不映射回主会话', async () => {
    useChatStore.getState().openDirectAgentSession('pm', {});
    await useChatStore.getState().loadHistory();

    const keys = sessionKeysCalledWith('chat.history');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain(PRIVATE_KEY);
    expect(keys).not.toContain(MAIN_KEY);
    await flush();
  });

  it('私聊历史与主会话历史隔离，互不串台', async () => {
    rpcMock.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'chat.history') {
        const key = String((params as { sessionKey?: string })?.sessionKey ?? '');
        if (key === PRIVATE_KEY) {
          return { messages: [{ role: 'user', content: '私聊里的悄悄话', timestamp: 1751000000 }] };
        }
        if (key === MAIN_KEY) {
          return { messages: [{ role: 'user', content: '主会话工作历史', timestamp: 1751000001 }] };
        }
        return { messages: [] };
      }
      return {};
    });

    useChatStore.getState().openDirectAgentSession('pm', {});
    await useChatStore.getState().loadHistory();
    expect(useChatStore.getState().messages.map((m) => m.content)).toContain('私聊里的悄悄话');
    expect(useChatStore.getState().messages.map((m) => m.content)).not.toContain('主会话工作历史');

    useChatStore.getState().switchSession(MAIN_KEY);
    await useChatStore.getState().loadHistory();
    expect(useChatStore.getState().messages.map((m) => m.content)).toContain('主会话工作历史');
    expect(useChatStore.getState().messages.map((m) => m.content)).not.toContain('私聊里的悄悄话');
    await flush();
  });

  it('sendMessage 在私聊会话下用私聊 key 调 chat.send，不写入主会话', async () => {
    vi.useFakeTimers();
    try {
      rpcMock.mockImplementation(async (method: string) =>
        method === 'chat.send' ? { runId: 'run-private-1' } : { messages: [] });

      useChatStore.getState().openDirectAgentSession('pm', {});
      await useChatStore.getState().loadHistory();
      await useChatStore.getState().sendMessage('这条只有你能看到');

      const keys = sessionKeysCalledWith('chat.send');
      expect(keys).toEqual([PRIVATE_KEY]);
      expect(sessionKeysCalledWith('chat.send')).not.toContain(MAIN_KEY);
    } finally {
      vi.useRealTimers();
    }
    await flush();
  });

  it('私聊视图下忽略主会话的流式事件', async () => {
    useChatStore.getState().openDirectAgentSession('pm', {});
    await flush();
    useChatStore.setState({ messages: [] } as never);

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-main-1',
      sessionKey: MAIN_KEY,
      message: { role: 'assistant', content: '主会话的回复', timestamp: 1751000002 },
    });

    expect(useChatStore.getState().messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
    await flush();
  });
});
