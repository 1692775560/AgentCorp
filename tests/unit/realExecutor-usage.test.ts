/**
 * tests/unit/realExecutor-usage.test.ts
 *
 * runRealChat / runRealExecution 的用量上报（成本看板采集口）：
 * - 响应带 usage 时调用已注入的 reporter（含调用上下文 ctx 透传）；
 * - 无 usage 字段时照常返回（reporter 收到 null，由渲染层 trackLlmUsage 内部跳过）；
 * - reporter 抛错时聊天主流程不受影响（采集失败静默）；
 * - 未注入 reporter 时（如纯 node 环境）不报错。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runRealChat, runRealExecution, setLlmUsageReporter } from '@/engine/llm/realExecutor';

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setLlmUsageReporter(null);
});

describe('runRealChat 用量上报', () => {
  it('响应带 usage 时上报，ctx 第三参透传（taskId/teamId/agentId）', async () => {
    const reporter = vi.fn();
    setLlmUsageReporter(reporter);
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      content: 'done',
      model: 'deepseek-chat',
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    })));

    const ctx = { taskId: 'task-1', teamId: 'team-1', agentId: 'a1' };
    await expect(runRealChat([{ role: 'user', content: 'hi' }], 2048, ctx)).resolves.toBe('done');

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(
      { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      'deepseek-chat',
      ctx,
    );
  });

  it('ctx 也可放第四参（第三参仍是 timeoutMs 数字）', async () => {
    const reporter = vi.fn();
    setLlmUsageReporter(reporter);
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      content: 'done',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })));

    const ctx = { agentId: 'a2' };
    await runRealChat([{ role: 'user', content: 'hi' }], 2048, 60_000, ctx);
    expect(reporter).toHaveBeenCalledWith(expect.anything(), null, ctx);
  });

  it('无 usage 字段时正常返回（reporter 收到 null，由渲染层内部跳过）', async () => {
    const reporter = vi.fn();
    setLlmUsageReporter(reporter);
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ content: 'done' })));

    await expect(runRealChat([{ role: 'user', content: 'hi' }])).resolves.toBe('done');
    expect(reporter).toHaveBeenCalledWith(null, null, undefined);
  });

  it('reporter 抛错不影响聊天主流程', async () => {
    setLlmUsageReporter(() => {
      throw new Error('reporter boom');
    });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      content: 'done',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })));

    await expect(runRealChat([{ role: 'user', content: 'hi' }])).resolves.toBe('done');
  });

  it('未注入 reporter 时也能正常返回（无上报）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      content: 'done',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })));

    await expect(runRealChat([{ role: 'user', content: 'hi' }])).resolves.toBe('done');
  });
});

describe('runRealExecution 用量上报', () => {
  it('单 agent 真实执行同样上报 usage 与 ctx', async () => {
    const reporter = vi.fn();
    setLlmUsageReporter(reporter);
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      content: 'done',
      model: 'deepseek-chat',
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    })));

    const ctx = { taskId: 'task-9', agentId: 'a9' };
    const result = await runRealExecution({ message: 'hi' }, ctx);
    expect(result.content).toBe('done');
    expect(reporter).toHaveBeenCalledWith(
      { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      'deepseek-chat',
      ctx,
    );
  });
});
