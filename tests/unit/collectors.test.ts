/**
 * tests/unit/collectors.test.ts
 *
 * 采集器单测（T05 / 真实遥测链路改造后）：
 * - tokenUsageCollector.buildRoiSnapshot（纯函数，渲染层保留）
 * - electron/services/evaluation/eval-data.ts 的 collectRunData / listAgentSessions
 *   （主进程采集，fs 与 token-usage 用 vi.mock 替身）
 *
 * 运行：pnpm test
 */
import { describe, it, expect, vi } from 'vitest';

const TOKEN_ENTRIES = [
  {
    timestamp: '2025-01-01T00:00:00Z',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1500,
    costUsd: 0.2,
  },
  {
    timestamp: '2025-01-01T00:01:00Z',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    inputTokens: 800,
    outputTokens: 300,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1100,
    costUsd: 0.1,
  },
];

// 替身：返回 fixture 用量
vi.mock('@electron/utils/token-usage', () => ({
  getRecentTokenUsageHistory: vi.fn(async () => TOKEN_ENTRIES),
}));

// 替身：fs/promises —— readdir 抛错模拟 sessions 目录不存在（缺转录路径）
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(async () => {
    throw new Error('ENOENT');
  }),
  readFile: vi.fn(async () => {
    throw new Error('ENOENT');
  }),
  access: vi.fn(async () => {
    throw new Error('ENOENT');
  }),
  stat: vi.fn(async () => {
    throw new Error('ENOENT');
  }),
}));

import { buildRoiSnapshot, tokenUsageCollector } from '@/services/tokenUsageCollector';
import { collectRunData, listAgentSessions } from '@electron/services/evaluation/eval-data';
import type { TelemetryEvent } from '@/types/evaluation';

describe('tokenUsageCollector.buildRoiSnapshot', () => {
  it('成本主线 = 五要素合计（ΣcostUsd + c_call + c_ret）；价值主线驱动 ROI/IPR/SRPC', () => {
    const telemetry: TelemetryEvent[] = [
      { agent_id: 'agent-1', task_id: 'sess-1', success: true, first_try: true, rework: 0, latency_ms: 0, human_interventions: 0, escalations: 0, out_of_domain: false, ts: '2025-01-01T00:00:00Z' },
      { agent_id: 'agent-1', task_id: 'sess-1', success: false, first_try: false, rework: 1, latency_ms: 0, human_interventions: 0, escalations: 0, out_of_domain: false, ts: '2025-01-01T00:01:00Z' },
    ];
    const roi = buildRoiSnapshot(TOKEN_ENTRIES as any, telemetry, 'agent-1', '2025-W30');

    expect(roi.agentId).toBe('agent-1');
    expect(roi.window).toBe('2025-W30');
    expect(roi.cost_total).toBeCloseTo(0.303); // ΣcostUsd 0.3 + c_call 2×0.001 + c_ret 1×0.001（五要素成本模型，评估设计 §3）

    // TCR = 1 success / 2 = 0.5 → U_task = 0.5 * 100 = 50；V_total = 50
    expect(roi.value_total).toBeCloseTo(50);
    expect(roi.ipr).toBeCloseTo(50 / 0.303);
    expect(roi.srpc).toBeCloseTo(1 / 0.303); // n_success = 1
    expect(roi.roi).toBeCloseTo((50 - 0.303) / 0.303);
  });

  it('cost_perf_score 落在 [0,5]；无 population → roi_norm 为 undefined', () => {
    const roi = buildRoiSnapshot(TOKEN_ENTRIES as any, [], 'agent-1', '2025-W30', {
      radarCost: 4,
      population: undefined,
    });
    expect(roi.cost_perf_score).toBeGreaterThanOrEqual(0);
    expect(roi.cost_perf_score).toBeLessThanOrEqual(5);
    expect(roi.roi_norm).toBeUndefined();
  });

  it('聚合对象导出 collectBySession/buildRoiSnapshot 可用', () => {
    expect(typeof tokenUsageCollector.buildRoiSnapshot).toBe('function');
    expect(typeof tokenUsageCollector.collectBySession).toBe('function');
  });
});

describe('eval-data.collectRunData（主进程采集）', () => {
  it('无转录文件时从真实 usage 回退派生最小 TelemetryEvent[]，且 transcript 为空', async () => {
    const data = await collectRunData('agent-1', 'sess-1');
    expect(data.transcript).toBe('');
    expect(data.entries.length).toBeGreaterThan(0);
    expect(data.events.length).toBeGreaterThan(0);
    for (const e of data.events) {
      expect(e.agent_id).toBe('agent-1');
      expect(e.task_id).toBe('sess-1');
      expect(e.success).toBe(true);
      expect(e.first_try).toBe(true);
      expect(e.rework).toBe(0);
      expect(e.escalations).toBe(0);
      expect(typeof e.ts).toBe('string');
    }
  });

  it('agentId 非法（路径穿越）时抛错', async () => {
    await expect(collectRunData('../../etc', 'sess-1')).rejects.toThrow('Invalid agentId');
  });

  it('agentId 与 sessionId 均缺失时抛错', async () => {
    await expect(collectRunData('', '')).rejects.toThrow('至少提供一个');
  });
});

describe('eval-data.listAgentSessions', () => {
  it('sessions 目录不可读时返回空数组', async () => {
    expect(await listAgentSessions('agent-1')).toEqual([]);
  });

  it('agentId 非法（路径穿越）时抛错', async () => {
    await expect(listAgentSessions('../..')).rejects.toThrow('Invalid agentId');
  });
});
