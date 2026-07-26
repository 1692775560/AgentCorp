/**
 * src/engine/roiEngine.ts
 * ROI / 效率引擎（评估设计 §3）：把成本五要素 + 价值两要素折算为
 * ROI / IPR / SRPC / CPS，并做跨 agent 归一化（z-score）。
 *
 * 设计约束（阶段 A）：
 * - 纯函数、无副作用、可单测。
 * - 与六维「性价比」维融合：cost_perf = λ·(CPS/5) + (1−λ)·(radar.cost/5)，
 *   最终进入 RoiSnapshot.cost_perf_score（0–5），并供 radar.ts 的 user_fit 融合（R3/R5 防注水）。
 * - 难度权重表 W 让异构任务效用可比；群体 z-score 让不同 agent 横向可比。
 */
import { RoiSnapshot } from "../types/evaluation";

/** 成本五要素（统一折算为成本当量 CU） */
export interface CostInput {
  c_tok: number; // token 成本（n_in·p_in + n_out·p_out）
  c_npu: number; // NPU 算力时长成本（h_npu·p_npu）
  c_call: number; // 调用次数开销（n_call·p_call）
  c_hum: number; // 人工干预成本（t_hum·w_hum）
  c_ret: number; // 失败重试成本（Σ 重试 token+时长+人工）
}

/** 价值两要素 */
export interface ValueInput {
  /** 难度权重表 w_k（Σ=1，见评估设计 §3.5 W 表） */
  weight: Record<string, number>;
  /** 各任务类型的成功度 s_k（0–1 连续度，1=完全成功） */
  success: Record<string, number>;
  /** 单位效用基准 U_base（CU） */
  U_base: number;
  /** 重试效用折损 ρ ∈ (0,1]，一次成功 ρ^0 = 1 */
  rho: number;
  /** 失败重试次数（折损指数） */
  n_retry: number;
  /** 成功任务数（用于 SRPC） */
  n_success: number;
  /** 节省人力价值 V_hum（t_saved·w_hum） */
  V_hum: number;
}

/** 计算选项 */
export interface RoiComputeOptions {
  /** 六维 cost 维（模型主观，0–5），提供时启用 cost_perf 融合 */
  radarCost?: number;
  /** 融合权重 λ（客观 CPS 占比），默认 0.5 */
  lambda?: number;
  /** ROI 群体数组，提供时计算 roi_norm z-score */
  population?: number[];
}

/** ROI 相对基线（标准 agent / 标准任务集），默认 1.0 */
export const DEFAULT_ROI_BASELINE = 1.0;

/** 融合权重 λ 默认 0.5（治理视图可调高至 0.8 以重客观审计） */
export const DEFAULT_LAMBDA = 0.5;

/** 数值裁剪 */
const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

/** CPS 归一化：IPR → 0–5（IPR=5 封顶 5.0） */
export function normCps(ipr: number, refMax = 5): number {
  return clamp((ipr / refMax) * 5, 0, 5);
}

/** 群体 z-score 标准化（σ 为 0 时回退 1e-9 防除零） */
export function zscore(pop: number[], x: number): number {
  if (pop.length === 0) return 0;
  const mean = pop.reduce((a, b) => a + b, 0) / pop.length;
  const variance =
    pop.reduce((a, b) => a + (b - mean) * (b - mean), 0) / pop.length;
  const std = Math.sqrt(variance) || 1e-9;
  return (x - mean) / std;
}

/**
 * 主线计算：成本 + 价值 → ROI / IPR / SRPC / CPS / roi_index / roi_norm。
 * @returns 部分 RoiSnapshot（agentId / window 由调用方补全）
 */
export function computeRoi(
  cost: CostInput,
  value: ValueInput,
  baseline: number = DEFAULT_ROI_BASELINE,
  opts: RoiComputeOptions = {},
): Omit<RoiSnapshot, "agentId" | "window"> {
  const C_total =
    cost.c_tok + cost.c_npu + cost.c_call + cost.c_hum + cost.c_ret;

  // 任务效用 U_task = Σ(w_k · s_k) · U_base
  let U_task = 0;
  for (const k of Object.keys(value.weight)) {
    U_task += (value.weight[k] ?? 0) * (value.success[k] ?? 0);
  }
  U_task *= value.U_base;

  // 重试效用折损 U_eff = U_task · ρ^n_retry
  const U_eff = U_task * Math.pow(value.rho, value.n_retry);

  // 价值总量 V_total = U_eff + V_hum
  const V_total = U_eff + value.V_hum;

  // ROI 主线与衍生
  const roi = C_total > 0 ? (V_total - C_total) / C_total : 0;
  const ipr = C_total > 0 ? V_total / C_total : 0;
  const srpc = C_total > 0 ? value.n_success / C_total : 0;
  const cps = normCps(ipr);

  // 性价比分（0–5）：客观 CPS 与主观雷达 cost 维融合（评估设计 §3.4）
  const lambda = opts.lambda ?? DEFAULT_LAMBDA;
  let cost_perf_score = cps; // 默认纯客观
  if (opts.radarCost != null) {
    const costPerfNorm = lambda * (cps / 5) + (1 - lambda) * (opts.radarCost / 5);
    cost_perf_score = clamp(costPerfNorm * 5, 0, 5);
  }

  // 跨 agent 可比
  const roi_index = baseline !== 0 ? roi / baseline : 0;
  const roi_norm = opts.population ? zscore(opts.population, roi) : undefined;

  return {
    cost_total: C_total,
    value_total: V_total,
    roi,
    ipr,
    srpc,
    cost_perf_score,
    roi_index,
    roi_norm,
    // window / agentId 由调用方补全
  } as Omit<RoiSnapshot, "agentId" | "window">;
}
