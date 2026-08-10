/**
 * tests/unit/interviewRunner.test.ts
 *
 * 面试调度器单测。核心锁的是「防串题」契约：
 *  - 网关返回 timestamp 时：早于提问时刻的 assistant 消息不得采信
 *  - 网关不返回 timestamp 时：靠 baseCount（提问前历史条数）区分新旧
 *    → 位置在 baseCount 之前的旧回复不得采信（此前退化成「取最后一条」，
 *      会把上一题的回答当成本题答案，静默污染评分证据）
 *  - baseCount 未知（null）且无 timestamp：宁可返回空，降级手动录入
 *  - flattenContent 把 ContentBlock[] 拍平成纯文本
 *
 * 隔离：mock '@/lib/api-client'，不触达 IPC / 网关。运行：pnpm test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeIpcMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

import { fetchLatestReply, flattenContent } from '@/services/interviewRunner';

/** 构造 chat.history 的成功响应 */
function history(messages: unknown[]) {
  return { success: true, result: { messages } };
}

beforeEach(() => {
  invokeIpcMock.mockReset();
});

describe('flattenContent', () => {
  it('拍平 ContentBlock[] 只保留 text 块', () => {
    const out = flattenContent([
      { type: 'text', text: '第一段' },
      { type: 'image', source: 'x' },
      { type: 'text', text: '第二段' },
    ]);
    expect(out).toBe('第一段\n第二段');
  });

  it('字符串原样返回，非数组返回空串', () => {
    expect(flattenContent('hello')).toBe('hello');
    expect(flattenContent(null)).toBe('');
    expect(flattenContent(42)).toBe('');
  });
});

describe('fetchLatestReply · 时间戳过滤', () => {
  it('早于提问时刻的回复不采信', async () => {
    const askedAt = 1_700_000_000_000;
    invokeIpcMock.mockResolvedValue(
      history([
        { role: 'user', content: '上一题', timestamp: askedAt - 20_000 },
        { role: 'assistant', content: '上一题的旧回答', timestamp: askedAt - 10_000 },
      ]),
    );
    expect(await fetchLatestReply('sk-1', askedAt, 2)).toBe('');
  });

  it('晚于提问时刻的回复正常采信', async () => {
    const askedAt = 1_700_000_000_000;
    invokeIpcMock.mockResolvedValue(
      history([
        { role: 'assistant', content: '旧回答', timestamp: askedAt - 10_000 },
        { role: 'user', content: '本题', timestamp: askedAt + 1_000 },
        { role: 'assistant', content: '本题的新回答', timestamp: askedAt + 5_000 },
      ]),
    );
    expect(await fetchLatestReply('sk-1', askedAt, 1)).toBe('本题的新回答');
  });

  it('秒级时间戳按毫秒归一化后比较', async () => {
    const askedAt = 1_700_000_000_000;
    invokeIpcMock.mockResolvedValue(
      history([{ role: 'assistant', content: '秒级新回答', timestamp: 1_700_000_005 }]),
    );
    expect(await fetchLatestReply('sk-1', askedAt, 0)).toBe('秒级新回答');
  });
});

describe('fetchLatestReply · 无时间戳时靠 baseCount 防串题', () => {
  const askedAt = 1_700_000_000_000;

  it('位置在 baseCount 之前的旧回复不得当成本题答案', async () => {
    // 提问前已有 2 条历史；本题尚无回复 → 必须返回空，而非取上一题的回答
    invokeIpcMock.mockResolvedValue(
      history([
        { role: 'user', content: '第一题' },
        { role: 'assistant', content: '第一题的回答' },
      ]),
    );
    expect(await fetchLatestReply('sk-1', askedAt, 2)).toBe('');
  });

  it('位置在 baseCount 之后的回复正常采信', async () => {
    invokeIpcMock.mockResolvedValue(
      history([
        { role: 'user', content: '第一题' },
        { role: 'assistant', content: '第一题的回答' },
        { role: 'user', content: '第二题' },
        { role: 'assistant', content: '第二题的回答' },
      ]),
    );
    expect(await fetchLatestReply('sk-1', askedAt, 2)).toBe('第二题的回答');
  });

  it('baseCount 未知时不猜，返回空以降级手动录入', async () => {
    invokeIpcMock.mockResolvedValue(
      history([{ role: 'assistant', content: '来源不明的回答' }]),
    );
    expect(await fetchLatestReply('sk-1', askedAt, null)).toBe('');
  });
});

describe('fetchLatestReply · 异常与空态', () => {
  it('网关失败返回空串而非抛错', async () => {
    invokeIpcMock.mockRejectedValue(new Error('gateway down'));
    expect(await fetchLatestReply('sk-1', Date.now(), 0)).toBe('');
  });

  it('success=false 返回空串', async () => {
    invokeIpcMock.mockResolvedValue({ success: false, error: 'nope' });
    expect(await fetchLatestReply('sk-1', Date.now(), 0)).toBe('');
  });

  it('空白回复不采信（继续往前找）', async () => {
    const askedAt = 1_700_000_000_000;
    invokeIpcMock.mockResolvedValue(
      history([
        { role: 'assistant', content: '有效回答', timestamp: askedAt + 1_000 },
        { role: 'assistant', content: '   ', timestamp: askedAt + 2_000 },
      ]),
    );
    expect(await fetchLatestReply('sk-1', askedAt, 0)).toBe('有效回答');
  });
});
