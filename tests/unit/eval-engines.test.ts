/**
 * tests/unit/eval-engines.test.ts
 *
 * 纯函数引擎单测（AgentCorp 评估层，T04/T05 引擎）：
 *  - metricsEngine.computeKpi        —— 遥测 → KPI（sample_n / 各率字段范围 / 稳定性）
 *  - roiEngine.computeRoi            —— 成本五要素 + 价值两要素 → ROI/IPR/SRPC/CPS/roi_norm
 *  - evaluationAdapter               —— consume(radar_update×6 + verdict + done) → 快照
 *  - verdict→lifecycle 一致性        —— lifecycle.verdictToLifecycleState 与 evaluationAdapter 映射对齐
 *
 * 这些模块仅依赖类型（编译期擦除），无 electron / 网络依赖，可在 vitest（node）直接执行。
 * 运行：pnpm test  (或 pnpm vitest run tests/unit/eval-engines.test.ts)
 */
import { describe, it, expect } from 'vitest';
import {
  computeKpi,
  taskCompletionRate,
  firstSuccessRate,
  reworkRate,
  avgLatency,
  autonomyRate,
  escalationRate,
  crossGen,
  stability,
} from '@/engine/metricsEngine';
import { computeRoi, normCps, zscore } from '@/engine/roiEngine';
import { EvaluationAdapter } from '@/engine/evaluationAdapter';
import { verdictToLifecycleState } from '@/types/lifecycle';
import type { TelemetryEvent, RadarScore, KpiRecord } from '@/types/evaluation';

const WINDOW = '2025-W30';

function mkEvent(over: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    agent_id: 'agent-1',
    task_id: 'task-1',
    success: true,
    first_try: true,
    rework: 0,
    latency_ms: 100,
    human_interventions: 0,
    escalations: 0,
    out_of_domain: false,
    ts: '2025-01-01T00:00:00Z',
    ...over,
  };
}

const ZERO_RADAR: RadarScore = {
  task: 0,
  quality: 0,
  comm: 0,
  creativity: 0,
  reliability: 0,
  cost: 0,
};

describe('metricsEngine.computeKpi', () => {
  const events: TelemetryEvent[] = [
    mkEvent({ success: true, first_try: true, rework: 0, latency_ms: 100 }),
    mkEvent({ success: true, first_try: false, rework: 1, latency_ms: 200, escalations: 1 }),
    mkEvent({ success: false, first_try: false, rework: 2, latency_ms: 300, human_interventions: 1 }),
    mkEvent({ success: true, first_try: true, rework: 0, latency_ms: 400, out_of_domain: true }),
    mkEvent({ success: true, first_try: false, rework: 0, latency_ms: 500 }),
  ];

  it('聚合基本 KPI 且 sample_n 正确', () => {
    const kpi = computeKpi(events, WINDOW);
    expect(kpi.agentId).toBe('agent-1');
    expect(kpi.sample_n).toBe(5);
    expect(kpi.window).toBe(WINDOW);
    expect(kpi.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('各派生率字段在 [0,1]', () => {
    const kpi = computeKpi(events, WINDOW);
    for (const key of [
      'task_completion_rate',
      'first_success_rate',
      'rework_rate',
      'autonomy_rate',
      'escalation_rate',
      'cross_task_generalization',
      'stability_consistency',
    ] as const) {
      expect(kpi[key]).toBeGreaterThanOrEqual(0);
      expect(kpi[key]).toBeLessThanOrEqual(1);
    }
  });

  it('TCR / FSR / RR / ADL 数值正确', () => {
    expect(taskCompletionRate(events)).toBeCloseTo(4 / 5);
    expect(firstSuccessRate(events)).toBeCloseTo(2 / 5);
    expect(reworkRate(events)).toBeCloseTo(2 / 4); // 完成的 4 个中 2 个有 rework
    expect(avgLatency(events)).toBeCloseTo((100 + 200 + 300 + 400 + 500) / 5);
  });

  it('空事件 → 全 0 且 agentId 回退 unknown', () => {
    const kpi = computeKpi([], WINDOW);
    expect(kpi.sample_n).toBe(0);
    expect(kpi.agentId).toBe('unknown');
    expect(kpi.task_completion_rate).toBe(0);
  });

  it('radarHistory<2 时稳定性退化为 1.0；>=2 时落在 [0,1]', () => {
    expect(stability([ZERO_RADAR])).toBe(1.0);
    const a: RadarScore = { ...ZERO_RADAR, task: 5, quality: 4 };
    const b: RadarScore = { ...ZERO_RADAR, task: 3, quality: 2 };
    const s = stability([a, b]);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('computedAt 可由调用方确定性传入（复现用）', () => {
    const kpi = computeKpi(events, WINDOW, [], '2025-01-01T00:00:00.000Z');
    expect(kpi.computedAt).toBe('2025-01-01T00:00:00.000Z');
  });
});

describe('roiEngine.computeRoi', () => {
  const cost = { c_tok: 2, c_npu: 0, c_call: 0.001, c_hum: 0, c_ret: 0 };
  const value = {
    weight: { task: 1 },
    success: { task: 0.8 },
    U_base: 100,
    rho: 1,
    n_retry: 0,
    n_success: 10,
    V_hum: 0,
  };

  it('主线公式：cost_total / value_total / roi / ipr / srpc / cps', () => {
    const r = computeRoi(cost, value);
    expect(r.cost_total).toBeCloseTo(2.001);
    const U_task = 0.8 * 100; // = 80
    expect(r.value_total).toBeCloseTo(U_task);
    expect(r.roi).toBeCloseTo((U_task - 2.001) / 2.001);
    expect(r.ipr).toBeCloseTo(U_task / 2.001);
    expect(r.srpc).toBeCloseTo(10 / 2.001);
    // CPS 已并入 cost_perf_score（无 radarCost 时即纯客观 CPS，见 RoiSnapshot 契约）
    expect(r.cost_perf_score).toBeGreaterThanOrEqual(0);
    expect(r.cost_perf_score).toBeLessThanOrEqual(5);
  });

  it('roi_index = roi / baseline', () => {
    const r = computeRoi(cost, value, 2.0);
    expect(r.roi_index).toBeCloseTo(r.roi / 2.0);
  });

  it('无 population → roi_norm 为 undefined；有 population → 数值', () => {
    const without = computeRoi(cost, value);
    expect(without.roi_norm).toBeUndefined();
    const withPop = computeRoi(cost, value, 1.0, { population: [0.1, 0.2, 0.3] });
    expect(typeof withPop.roi_norm).toBe('number');
  });

  it('cost_perf 融合（提供 radarCost）落在 [0,5]', () => {
    const r = computeRoi(cost, value, 1.0, { radarCost: 4, lambda: 0.5 });
    expect(r.cost_perf_score).toBeGreaterThanOrEqual(0);
    expect(r.cost_perf_score).toBeLessThanOrEqual(5);
  });

  it('normCps 将 IPR 裁剪到 0–5；zscore 群体标准化', () => {
    expect(normCps(10)).toBeCloseTo(5); // 封顶 5
    expect(normCps(-5)).toBe(0);
    expect(zscore([1, 2, 3], 2)).toBeCloseTo(0);
  });
});

describe('evaluationAdapter.consume', () => {
  const DIMS: Array<keyof RadarScore> = [
    'task',
    'quality',
    'comm',
    'creativity',
    'reliability',
    'cost',
  ];

  it('消费 radar_update×6 → 快照含全部维度', () => {
    const adapter = new EvaluationAdapter();
    for (const dim of DIMS) {
      const d = adapter.consume({ type: 'radar_update', dim, score: 4, confidence: 0.9, evidence: 'e' });
      expect(d.kind).toBe('radar');
    }
    const snap = adapter.snapshot();
    for (const dim of DIMS) expect(typeof snap.radar[dim]).toBe('number');
  });

  it('verdict FIRED → RETIRED；MVP/OBSERVE → ACTIVE', () => {
    const fired = new EvaluationAdapter();
    fired.consume({ type: 'verdict', verdict: 'FIRED', user_fit: 10, evidence_trace: [], confidence: 0.8 });
    expect(fired.snapshot().state).toBe('RETIRED');

    const mvp = new EvaluationAdapter();
    mvp.consume({ type: 'verdict', verdict: 'MVP', user_fit: 90, evidence_trace: [], confidence: 0.9 });
    expect(mvp.snapshot().state).toBe('ACTIVE');

    const obs = new EvaluationAdapter();
    obs.consume({ type: 'verdict', verdict: 'OBSERVE', user_fit: 50, evidence_trace: [], confidence: 0.8 });
    expect(obs.snapshot().state).toBe('ACTIVE');
  });

  it('done / noop 事件处理', () => {
    const a = new EvaluationAdapter();
    expect(a.consume({ type: 'done', evaluation_id: 'x' }).kind).toBe('done');
  });
});

describe('verdict→lifecycle 一致性（lifecycle.ts vs evaluationAdapter）', () => {
  it('verdictToLifecycleState 与 adapter 内部映射完全一致', () => {
    const cases: Array<['MVP' | 'OBSERVE' | 'FIRED', 'ACTIVE' | 'RETIRED']> = [
      ['MVP', 'ACTIVE'],
      ['OBSERVE', 'ACTIVE'],
      ['FIRED', 'RETIRED'],
    ];
    for (const [verdict, expected] of cases) {
      expect(verdictToLifecycleState(verdict)).toBe(expected);
      const adapter = new EvaluationAdapter();
      adapter.consume({ type: 'verdict', verdict, user_fit: 50, evidence_trace: [], confidence: 0.8 });
      expect(adapter.snapshot().state).toBe(expected);
    }
  });
});
