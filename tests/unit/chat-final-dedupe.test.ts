import { beforeEach, describe, expect, it } from 'vitest';

import { useChatStore } from '@/stores/chat';

const SESSION_KEY = 'agent:test:main';
let seq = 0;

function resetStore() {
  useChatStore.setState({
    messages: [],
    currentSessionKey: SESSION_KEY,
    activeRunId: null,
    sending: false,
    error: null,
    streamingText: '',
    streamingMessage: null,
    pendingFinal: false,
  } as never);
}

// 事件级查重是模块级缓存(30s TTL), 每个用例用不同的 runId 避免串扰;
// timestamp 由调用方显式传入(秒), 以便精确控制时间窗口
function finalEvent(text: string, timestamp: number) {
  seq += 1;
  return {
    state: 'final',
    runId: `run-dedupe-${seq}`,
    sessionKey: SESSION_KEY,
    message: {
      role: 'assistant',
      content: text,
      timestamp,
    },
  };
}

describe('chat final 事件查重', () => {
  beforeEach(() => {
    resetStore();
  });

  it('历史替换进来的无 id 回复 + 迟到的 final 事件 → 不重复 append', () => {
    const text = '你好！我是你的个人助理。';
    const ts = 1750100000;
    // 模拟 loadHistory 整体替换进来的历史消息（无本地合成 id）
    useChatStore.setState({
      messages: [{ role: 'assistant', content: text, timestamp: ts }],
    } as never);

    useChatStore.getState().handleChatEvent(finalEvent(text, ts));

    const assistantMsgs = useChatStore.getState().messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
  });

  it('final 已 append 后消息被去掉 id(模拟历史替换) + 迟到重放 → 仍不重复', () => {
    const text = '你好！我是你的个人助理。';
    const ts = 1750200000;
    useChatStore.getState().handleChatEvent(finalEvent(text, ts));
    // 模拟 loadHistory 替换: 同样的内容但丢失本地合成 id
    useChatStore.setState({
      messages: [{ role: 'assistant', content: text, timestamp: ts }],
    } as never);
    // 网关重放的迟到 final(内容相同, 时间戳秒级抖动)
    useChatStore.getState().handleChatEvent(finalEvent(text, ts + 5));

    const assistantMsgs = useChatStore.getState().messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
  });

  it('用户真的再问一次(时间相隔较远) → 两条都保留, 不误杀', () => {
    const text = '你好！我是你的个人助理。';
    const ts = 1750300000;
    useChatStore.getState().handleChatEvent(finalEvent(text, ts));
    useChatStore.getState().handleChatEvent(finalEvent(text, ts + 600));

    const assistantMsgs = useChatStore.getState().messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(2);
  });
});
