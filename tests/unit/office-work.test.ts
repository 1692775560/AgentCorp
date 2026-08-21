/**
 * tests/unit/office-work.test.ts
 *
 * officeWork store 派活状态机单测（mock interviewRunner.askAgent，不触网关）：
 * - 空任务 → noop；缺 sessionKey → 明确 failed（不静默）；
 * - 真实调度成功 → done（reply/runId/latency 回填）；
 * - manual 降级 → failed 且 error 明示降级；
 * - agent 空回复 → failed；
 * - reset 清记录回 idle。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const askAgentMock = vi.fn();
vi.mock('@/services/interviewRunner', () => ({
  askAgent: (...args: unknown[]) => askAgentMock(...args),
}));

import { useOfficeWorkStore } from '@/stores/officeWork';

const store = () => useOfficeWorkStore.getState();

describe('officeWork.dispatch 状态机', () => {
  beforeEach(() => {
    askAgentMock.mockReset();
    useOfficeWorkStore.setState({ records: {} });
  });

  it('空任务 → noop（不产生记录、不发起调度）', async () => {
    await store().dispatch('a1', 'sess-1', '   ');
    expect(store().records['a1']).toBeUndefined();
    expect(askAgentMock).not.toHaveBeenCalled();
  });

  it('缺 sessionKey → failed 且错误明示（不静默吞）', async () => {
    await store().dispatch('a1', null, '写个周报');
    const rec = store().records['a1'];
    expect(rec.status).toBe('failed');
    expect(rec.error).toContain('会话键');
    expect(askAgentMock).not.toHaveBeenCalled();
  });

  it('真实调度成功 → done，回填 reply/runId/latency', async () => {
    askAgentMock.mockResolvedValue({
      mode: 'agent',
      replyText: '周报已完成',
      runId: 'run-1',
      latencyMs: 1234,
    });
    await store().dispatch('a1', 'sess-1', '写个周报');
    const rec = store().records['a1'];
    expect(rec.status).toBe('done');
    expect(rec.reply).toBe('周报已完成');
    expect(rec.runId).toBe('run-1');
    expect(rec.latencyMs).toBe(1234);
    expect(rec.mode).toBe('agent');
    expect(rec.error).toBeUndefined();
  });

  it('manual 降级 → failed 且 error 明示「网关未连接」', async () => {
    askAgentMock.mockResolvedValue({
      mode: 'manual',
      replyText: '',
      runId: null,
      latencyMs: null,
    });
    await store().dispatch('a1', 'sess-1', '写个周报');
    const rec = store().records['a1'];
    expect(rec.status).toBe('failed');
    expect(rec.mode).toBe('manual');
    expect(rec.error).toContain('降级');
  });

  it('agent 模式但空回复 → failed（不伪装成功）', async () => {
    askAgentMock.mockResolvedValue({
      mode: 'agent',
      replyText: '   ',
      runId: 'run-2',
      latencyMs: 500,
    });
    await store().dispatch('a1', 'sess-1', '写个周报');
    const rec = store().records['a1'];
    expect(rec.status).toBe('failed');
    expect(rec.error).toContain('超时');
  });

  it('reset → 删除记录（可再次派活）', async () => {
    askAgentMock.mockResolvedValue({
      mode: 'agent',
      replyText: 'ok',
      runId: 'run-3',
      latencyMs: 1,
    });
    await store().dispatch('a1', 'sess-1', '任务');
    expect(store().records['a1']).toBeDefined();
    store().reset('a1');
    expect(store().records['a1']).toBeUndefined();
  });
});
