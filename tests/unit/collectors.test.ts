/**
 * tests/unit/collectors.test.ts
 *
 * 采集器单测（T05）：tokenUsageCollector.buildRoiSnapshot（纯函数）+ telemetryCollector.collect 派生逻辑。
 *
 * 二者都依赖主进程能力（@electron/utils/token-usage 读 ~/.openclaw，@electron/utils/token-usage-core
 * 解析转录），在 Node 测试中无法访问真实文件系统 / electron 运行时，故用 vi.mock 替身
 * getRecentTokenUsageHistory 注入 fixtures，验证「真实用量 → TelemetryEvent / RoiSnapshot」的派生逻辑。
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

// 替身：返回 fixture 用量（telemetryCollector / tokenUsageCollector 均依赖）
vi.mock('@electron/utils/token-usage', () => ({
  getRecentTokenUsageHistory: vi.fn(async () => TOKEN_ENTRIES),
}));

// 替身：解析函数在本测试路径（无转录文件）不会被调用，给空实现即可
vi.mock('@electron/utils/token-usage-core', () => ({
  parseUsageEntriesFromJsonl: vi.fn(() => []),
  extractSessionIdFromTranscriptFileName: vi.fn(() => 'sess-1'),
}));

import { buildRoiSnapshot, tokenUsageCollector } from '@/services/tokenUsageCollector';
import { telemetryCollector } from '@/services/telemetryCollector';
import type { TelemetryEvent } from '@/types/evaluation';

describe('tokenUsageCollector.buildRoiSnapshot', () => {
  it('成本主线 = ΣcostUsd；价值主线驱动 ROI/IPR/SRPC', () => {
    const telemetry: TelemetryEvent[] = [
      { agent_id: 'agent-1', task_id: 'sess-1', success: true, first_try: true, rework: 0, latency_ms: 0, human_interventions: 0, escalations: 0, out_of_domain: false, ts: '2025-01-01T00:00:00Z' },
      { agent_id: 'agent-1', task_id: 'sess-1', success: false, first_try: false, rework: 1, latency_ms: 0, human_interventions: 0, escalations: 0, out_of_domain: false, ts: '2025-01-01T00:01:00Z' },
    ];
    const roi = buildRoiSnapshot(TOKEN_ENTRIES as any, telemetry, 'agent-1', '2025-W30');

    expect(roi.agentId).toBe('agent-1');
    expect(roi.window).toBe('2025-W30');
    expect(roi.cost_total).toBeCloseTo(0.3); // 0.2 + 0.1

    // TCR = 1 success / 2 = 0.5 → U_task = 0.5 * 100 = 50；V_total = 50
    expect(roi.value_total).toBeCloseTo(50);
    expect(roi.ipr).toBeCloseTo(50 / 0.3);
    expect(roi.srpc).toBeCloseTo(1 / 0.3); // n_success = 1
    expect(roi.roi).toBeCloseTo((50 - 0.3) / 0.3);
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

describe('telemetryCollector.collect（回退派生路径）', () => {
  it('无转录文件时从真实 usage 派生最小 TelemetryEvent[]', async () => {
    const events = await telemetryCollector.collect('sk-1', 'sess-1', 'agent-1');
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.agent_id).toBe('agent-1');
      expect(e.task_id).toBe('sess-1');
      expect(e.success).toBe(true);
      expect(e.first_try).toBe(true);
      expect(e.rework).toBe(0);
      expect(e.escalations).toBe(0);
      expect(typeof e.ts).toBe('string');
    }
  });

  it('readTranscript 在缺文件时安全返回空串', async () => {
    const t = await telemetryCollector.readTranscript('sk-1', 'sess-1', 'agent-1');
    expect(t).toBe('');
  });
});
