/**
 * tests/unit/eval-stores.test.ts
 *
 * 落库单测：
 * - electron/services/evaluation/eval-store.ts（主进程）：lazy import('electron-store')，
 *   用 in-memory FakeStore 替身验证 save/load/list/getByRunId 语义。
 * - src/services/runLinkStore.ts（渲染层客户端）：mock hostApiFetch 验证请求与回包处理。
 *
 * 运行：pnpm test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory 替身：实现 set/get/store 三个 store 使用到的接口
vi.mock('electron-store', () => {
  class FakeStore {
    private data = new Map<string, any>();
    constructor(_opts?: any) {}
    set(key: string, val: any) {
      this.data.set(key, val);
    }
    get(key: string) {
      return this.data.get(key);
    }
    get store() {
      return Object.fromEntries(this.data);
    }
  }
  return { default: FakeStore };
});

// 渲染层客户端的 Host API 替身（内存实现，模拟主进程路由行为）
const runLinks = new Map<string, any>();
vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/eval/runlinks' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const link = body.evaluatedAt
        ? body
        : { ...body, evaluatedAt: new Date().toISOString() };
      runLinks.set(link.runId, link);
      return { success: true, link };
    }
    const getMatch = path.match(/^\/api\/eval\/runlinks\/(.+)$/);
    if (getMatch) {
      const link = runLinks.get(decodeURIComponent(getMatch[1])) ?? null;
      return { success: true, link };
    }
    return { success: false, error: `unexpected path: ${path}` };
  }),
}));

import {
  saveProfile,
  loadProfile,
  listProfiles,
  saveRunLink,
  getRunLink,
} from '@electron/services/evaluation/eval-store';
import { saveForRun, getByRunId } from '@/services/runLinkStore';
import type { EvaluationProfile, RadarScore, KpiRecord, RoiSnapshot } from '@/types/evaluation';

function radar(v = 3): RadarScore {
  return { task: v, quality: v, comm: v, creativity: v, reliability: v, cost: v };
}
function kpi(agentId: string): KpiRecord {
  return {
    agentId,
    task_completion_rate: 1,
    first_success_rate: 1,
    rework_rate: 0,
    avg_delivery_latency_ms: 100,
    autonomy_rate: 1,
    escalation_rate: 0,
    cross_task_generalization: 0,
    stability_consistency: 1,
    sample_n: 5,
    window: '2025-W30',
    computedAt: '2025-01-01T00:00:00.000Z',
  };
}
function roi(agentId: string): RoiSnapshot {
  return {
    agentId,
    cost_total: 2,
    value_total: 10,
    roi: 4,
    ipr: 5,
    srpc: 5,
    cost_perf_score: 4,
    roi_index: 4,
    roi_norm: undefined,
    window: '2025-W30',
  };
}
function profile(agentId: string): EvaluationProfile {
  return {
    agentId,
    radarLatest: radar(),
    radarHistory: [radar()],
    kpiLatest: kpi(agentId),
    kpiHistory: [kpi(agentId)],
    roiLatest: roi(agentId),
    lifecycle: 'ACTIVE',
    runIds: ['run-1'],
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
}

describe('eval-store（主进程落库）', () => {
  it('saveProfile/loadProfile 往返一致', async () => {
    const p = profile('agent-eval-1');
    await saveProfile(p);
    expect(await loadProfile('agent-eval-1')).toEqual(p);
  });

  it('listProfiles 仅返回含 agentId 的 EvaluationProfile', async () => {
    await saveProfile(profile('agent-eval-2'));
    const all = await listProfiles();
    const ids = all.map((x) => x.agentId);
    expect(ids).toContain('agent-eval-1');
    expect(ids).toContain('agent-eval-2');
    for (const x of all) expect(typeof x.agentId).toBe('string');
  });

  it('loadProfile 缺失返回 undefined', async () => {
    expect(await loadProfile('no-such-agent')).toBeUndefined();
  });

  it('saveRunLink/getRunLink 往返一致；缺失返回 undefined', async () => {
    const link = {
      runId: 'run-main-1',
      taskId: 't1',
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      sessionId: 'sess-1',
      evaluatedAt: '2025-01-01T00:00:00.000Z',
    };
    await saveRunLink(link);
    expect(await getRunLink('run-main-1')).toEqual(link);
    expect(await getRunLink('does-not-exist')).toBeUndefined();
  });
});

describe('runLinkStore（渲染层客户端）', () => {
  beforeEach(() => {
    runLinks.clear();
  });

  it('saveForRun POST /api/eval/runlinks，服务端补 evaluatedAt', async () => {
    const link = await saveForRun('run-1', {
      taskId: 'task-1',
      agentId: 'agent-1',
      sessionKey: 'agent:agent-1:main',
      sessionId: 'sess-1',
    });
    expect(link.runId).toBe('run-1');
    expect(link.taskId).toBe('task-1');
    expect(link.agentId).toBe('agent-1');
    expect(link.sessionKey).toBe('agent:agent-1:main');
    expect(link.sessionId).toBe('sess-1');
    expect(typeof link.evaluatedAt).toBe('string');
  });

  it('getByRunId 可回读；缺失返回 undefined', async () => {
    await saveForRun('run-2', {
      taskId: 'task-2',
      agentId: 'agent-2',
      sessionKey: 'sk-2',
      sessionId: 'sess-2',
    });
    const got = await getByRunId('run-2');
    expect(got?.runId).toBe('run-2');
    expect(await getByRunId('does-not-exist')).toBeUndefined();
  });
});
