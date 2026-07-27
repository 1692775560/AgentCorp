/**
 * tests/unit/eval-stores.test.ts
 *
 * 本地落库单测（T03 / T06）：runLinkStore + evaluationStore。
 * 二者均 lazy import('electron-store')，在 Node 测试环境无 electron 运行时，
 * 故用 in-memory FakeStore 替身 electron-store，验证 save/load/list/getByRunId 行为。
 *
 * 注意：electron-store 在真实 Electron 主进程才可用；本测试仅验证落库逻辑，
 * 真实电子环境下由 vitest（含 electron 运行时）或端到端验证。
 * 运行：pnpm test
 */
import { describe, it, expect, vi } from 'vitest';

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

import { save as linkSave, saveForRun, getByRunId } from '@/services/runLinkStore';
import { save as evalSave, load, list } from '@/services/evaluationStore';
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

describe('runLinkStore', () => {
  it('saveForRun 补全 runId + evaluatedAt 并落库', async () => {
    const link = await saveForRun('run-1', {
      taskId: 'task-1',
      agentId: 'agent-1',
      sessionKey: 'sk-1',
      sessionId: 'sess-1',
    });
    expect(link.runId).toBe('run-1');
    expect(link.taskId).toBe('task-1');
    expect(link.agentId).toBe('agent-1');
    expect(link.sessionKey).toBe('sk-1');
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
    const missing = await getByRunId('does-not-exist');
    expect(missing).toBeUndefined();
  });

  it('save（完整 RunTaskLink）后 getByRunId 一致', async () => {
    const full = {
      runId: 'run-3',
      taskId: 't3',
      agentId: 'a3',
      sessionKey: 'sk3',
      sessionId: 'sess3',
      evaluatedAt: '2025-01-01T00:00:00.000Z',
    };
    await linkSave(full);
    const got = await getByRunId('run-3');
    expect(got).toEqual(full);
  });
});

describe('evaluationStore', () => {
  it('save/load 往返一致', async () => {
    const p = profile('agent-eval-1');
    await evalSave(p);
    const loaded = await load('agent-eval-1');
    expect(loaded).toEqual(p);
  });

  it('list 仅返回含 agentId 的 EvaluationProfile（过滤内部键）', async () => {
    await evalSave(profile('agent-eval-2'));
    const all = await list();
    const ids = all.map((x) => x.agentId);
    expect(ids).toContain('agent-eval-1');
    expect(ids).toContain('agent-eval-2');
    for (const x of all) expect(typeof x.agentId).toBe('string');
  });

  it('load 缺失返回 undefined', async () => {
    expect(await load('no-such-agent')).toBeUndefined();
  });
});
