import { describe, expect, it } from 'vitest';

import { isHeartbeatNoiseReply, isSystemInjectedUserMessage } from '@/pages/Chat/message-utils';

describe('心跳消息过滤', () => {
  it('网关心跳注入的 HEARTBEAT.md 读取指令被识别为系统消息', () => {
    expect(
      isSystemInjectedUserMessage({
        role: 'user',
        content: 'Read HEARTBEAT.md if it exists (workspace context). Reply HEARTBEAT_OK if nothing needs attention.',
      }),
    ).toBe(true);
  });

  it('带网关元数据前缀的心跳指令也能识别（不锚定开头）', () => {
    expect(
      isSystemInjectedUserMessage({
        role: 'user',
        content: '[2026-08-17 20:30:00] Conversation info\nRead heartbeat.md if it exists',
      }),
    ).toBe(true);
  });

  it('HEARTBEAT_OK 应答被识别为噪音回复', () => {
    expect(isHeartbeatNoiseReply({ role: 'assistant', content: 'HEARTBEAT_OK' })).toBe(true);
    expect(isHeartbeatNoiseReply({ role: 'assistant', content: '  HEARTBEAT_OK\n' })).toBe(true);
    // content 数组形态
    expect(
      isHeartbeatNoiseReply({ role: 'assistant', content: [{ type: 'text', text: 'HEARTBEAT_OK' }] }),
    ).toBe(true);
  });

  it('正常用户消息与正常回复不误伤', () => {
    expect(isSystemInjectedUserMessage({ role: 'user', content: '帮我看看这个文件 heartbeat 配置' })).toBe(false);
    expect(isSystemInjectedUserMessage({ role: 'user', content: '你好' })).toBe(false);
    expect(isHeartbeatNoiseReply({ role: 'assistant', content: 'HEARTBEAT_OK，另外我发现一个问题' })).toBe(false);
    expect(isHeartbeatNoiseReply({ role: 'assistant', content: '好的，已完成' })).toBe(false);
  });

  it('角色不匹配时不过滤', () => {
    expect(isSystemInjectedUserMessage({ role: 'assistant', content: 'Read HEARTBEAT.md if it exists' })).toBe(false);
    expect(isHeartbeatNoiseReply({ role: 'user', content: 'HEARTBEAT_OK' })).toBe(false);
    expect(isHeartbeatNoiseReply(null)).toBe(false);
  });
});
