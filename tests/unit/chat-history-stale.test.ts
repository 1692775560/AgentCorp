import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';

// loadHistory 健壮性回归：
// 1) RPC 在途期间用户切换会话，迟到的旧会话响应不得覆盖新会话的消息视图；
// 2) quiet 加载有 800ms 节流，刚切过去（消息区已清空）的场景用 force 绕过。

const SESSION_A = 'agent:main:stale-a';
const SESSION_B = 'agent:main:stale-b';
const SESSION_C = 'agent:main:force-c';

const rpcMock = vi.fn<(method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>>();

function resetStore() {
  useChatStore.setState({
    sessions: [
      { key: SESSION_A, displayName: SESSION_A },
      { key: SESSION_B, displayName: SESSION_B },
      { key: SESSION_C, displayName: SESSION_C },
    ],
    sessionLabels: {},
    sessionLastActivity: {},
    messages: [],
    currentSessionKey: SESSION_A,
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

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function historyCallCount(sessionKey: string): number {
  return rpcMock.mock.calls.filter(
    ([m, p]) => m === 'chat.history' && String((p as { sessionKey?: string })?.sessionKey ?? '') === sessionKey,
  ).length;
}

describe('loadHistory 陈旧守卫与 force', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ messages: [] });
    useGatewayStore.setState({ rpc: rpcMock } as never);
    resetStore();
  });

  afterEach(async () => {
    await flush();
  });

  it('迟到的旧会话历史响应被丢弃，不覆盖新会话视图', async () => {
    let resolveA: ((v: unknown) => void) | null = null;
    rpcMock.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'chat.history') {
        const key = String((params as { sessionKey?: string })?.sessionKey ?? '');
        if (key === SESSION_A) {
          return new Promise((resolve) => {
            resolveA = resolve;
          });
        }
        if (key === SESSION_B) {
          return { messages: [{ role: 'user', content: '会话B的消息', timestamp: 1751000001 }] };
        }
      }
      return {};
    });

    // A 的历史加载在途（慢网关）
    void useChatStore.getState().loadHistory();
    await flush();
    // 用户切到 B，B 的历史先到
    useChatStore.getState().switchSession(SESSION_B);
    await flush();
    expect(useChatStore.getState().messages.map((m) => String(m.content))).toContain('会话B的消息');

    // A 的迟到响应到达：不得覆盖 B 的视图
    resolveA?.({ messages: [{ role: 'user', content: '会话A的陈旧消息', timestamp: 1751000000 }] });
    await flush();
    const contents = useChatStore.getState().messages.map((m) => String(m.content));
    expect(contents).toContain('会话B的消息');
    expect(contents).not.toContain('会话A的陈旧消息');
  });

  it('quiet 节流生效，force 绕过节流', async () => {
    useChatStore.getState().switchSession(SESSION_C);
    await flush();
    const base = historyCallCount(SESSION_C);
    expect(base).toBeGreaterThan(0);

    // 立刻 quiet 再加载 → 被 800ms 节流吞掉
    await useChatStore.getState().loadHistory(true);
    expect(historyCallCount(SESSION_C)).toBe(base);

    // force 绕过节流（刚切过来消息区被清空的场景）
    await useChatStore.getState().loadHistory(true, true);
    expect(historyCallCount(SESSION_C)).toBe(base + 1);
  });
});
