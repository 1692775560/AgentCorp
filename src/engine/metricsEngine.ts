/**
 * src/engine/metricsEngine.ts
 * 指标引擎（评估）：把运行遥测 TelemetryEvent[] 聚合为可量化 KPI，
 * 把多轮 RadarScore 聚合为稳定性 SCR。
 *
 * 设计约束：
 * - 纯函数、无副作用、无外部依赖，可单测。
 * - 客观 KPI 全部来自遥测聚合，不依赖模型推断（缓解 PRD R1 元评估降智）。
 * - 合成数据（telemetrySynth）与未来真实遥测（TelemetryEvent 同 schema）共用本引擎。
 */
import { RadarScore, RadarDim, TelemetryEvent, KpiRecord } from "../types/evaluation";

/** 数值裁剪到 [lo, hi] */
const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

/** 任务完成率 TCR = 成功数 / 总数 */
export function taskCompletionRate(e: TelemetryEvent[]): number {
  if (e.length === 0) return 0;
  return e.filter((x) => x.success).length / e.length;
}

/** 一次成功率 FSR = 一次成功数 / 总数 */
export function firstSuccessRate(e: TelemetryEvent[]): number {
  if (e.length === 0) return 0;
  return e.filter((x) => x.first_try && x.success).length / e.length;
}

/** 返工率 RR = 返工任务数 / 完成任务数（失败不计入分母） */
export function reworkRate(e: TelemetryEvent[]): number {
  const completed = e.filter((x) => x.success).length;
  if (completed === 0) return 0;
  const reworked = e.filter((x) => x.rework > 0).length;
  return reworked / completed;
}

/** 平均交付时延 ADL（ms） */
export function avgLatency(e: TelemetryEvent[]): number {
  if (e.length === 0) return 0;
  return e.reduce((s, x) => s + x.latency_ms, 0) / e.length;
}

/** 自主完成率 AR = 无人工介入的完成任务数 / 完成任务数（仅在成功任务中统计） */
export function autonomyRate(e: TelemetryEvent[]): number {
  const completed = e.filter((x) => x.success);
  if (completed.length === 0) return 0;
  const auto = completed.filter((x) => x.human_interventions === 0).length;
  return auto / completed.length;
}

/** 升级/求助率 ER = 有升级的任务数 / 总数 */
export function escalationRate(e: TelemetryEvent[]): number {
  if (e.length === 0) return 0;
  return e.filter((x) => x.escalations > 0).length / e.length;
}

/** 跨任务泛化率 CGR = 跨域任务解决数 / 跨域任务数 */
export function crossGen(e: TelemetryEvent[]): number {
  const ood = e.filter((x) => x.out_of_domain);
  if (ood.length === 0) return 0;
  return ood.filter((x) => x.success).length / ood.length;
}

/**
 * 稳定性/多轮一致率 SCR = 1 − norm(std over rounds)。
 * 多轮雷达逐维标准差越小越稳定；轮数 <2 时退化为 1.0（无漂移基准）。
 */
export function stability(radars: RadarScore[]): number {
  if (radars.length < 2) return 1.0;
  const dims: RadarDim[] = [
    "task",
    "quality",
    "comm",
    "creativity",
    "reliability",
    "cost",
  ];
  let sumStd = 0;
  for (const d of dims) {
    const vals = radars.map((r) => r[d]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance =
      vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length;
    sumStd += Math.sqrt(variance);
  }
  const avgStd = sumStd / dims.length;
  return clamp(1 - avgStd / 5, 0, 1);
}

/**
 * 聚合单 agent 的遥测为 KPI 记录。
 * @param events 单 agent 的遥测数组
 * @param window 考核窗口（如 "2025-W30"）
 * @param radarHistory 可选的多轮雷达，用于计算稳定性 SCR
 * @param computedAt 可选确定时间戳（演示复现用），缺省取当前 UTC
 */
export function computeKpi(
  events: TelemetryEvent[],
  window: string,
  radarHistory: RadarScore[] = [],
  computedAt?: string,
): KpiRecord {
  const agentId = events.length > 0 ? events[0].agent_id : "unknown";
  return {
    agentId,
    task_completion_rate: taskCompletionRate(events),
    first_success_rate: firstSuccessRate(events),
    rework_rate: reworkRate(events),
    avg_delivery_latency_ms: avgLatency(events),
    autonomy_rate: autonomyRate(events),
    escalation_rate: escalationRate(events),
    cross_task_generalization: crossGen(events),
    stability_consistency: stability(radarHistory),
    sample_n: events.length,
    window,
    computedAt: computedAt ?? new Date().toISOString(),
  };
}
