/**
 * src/engine/interview/craftAggregate.ts
 * 多道试做题 → craft 维客观分的聚合（纯函数，可单测）。
 *
 * 原则与后端 craft_judge 一致，不在前端做任何补分：
 * - 只聚合真正被评过的维（judgement 为 null 的轮次整轮跳过）；
 * - 同一维被多题考到时取均值，并对齐 0.5 步进；
 * - 未被任何题覆盖的维不出现在结果里，由 unscored 单独列出；
 * - 注水（padding_detected）不在此处压分（后端 rubric 已压过），
 *   仅统计条数供 UI 提示，避免二次惩罚。
 */
import type { CraftTrialRound } from '@/types/interview';

/** craft 客观分聚合结果 */
export interface CraftAggregate {
  /** craft 维 → 0–5 分（0.5 步进），仅含被实际评过的维 */
  dims: Record<string, number>;
  /** 被考到但一次都没评上分的维（judge 未覆盖） */
  unscored: string[];
  /** 有效评分轮数（judgement 非 null） */
  judgedCount: number;
  /** 总轮数 */
  trialCount: number;
  /** 被判定注水的轮数 */
  paddingCount: number;
  /** 平均置信度（仅计有效轮），无有效轮时 null */
  avgConfidence: number | null;
}

/** 对齐 0–5 区间与 0.5 步进（与后端 round(x*2)/2 同口径） */
export function toHalfStep(value: number): number {
  const clamped = Math.min(5, Math.max(0, value));
  return Math.round(clamped * 2) / 2;
}

/** 聚合多轮试做题的 craft 维分数 */
export function aggregateCraftDims(trials: CraftTrialRound[]): CraftAggregate {
  const buckets: Record<string, number[]> = {};
  const unscoredSet = new Set<string>();
  const confidences: number[] = [];
  let judgedCount = 0;
  let paddingCount = 0;

  for (const trial of trials) {
    const judgement = trial.judgement;
    if (!judgement) continue;
    judgedCount += 1;
    if (judgement.padding_detected) paddingCount += 1;
    confidences.push(judgement.confidence);

    for (const [dim, score] of Object.entries(judgement.dims)) {
      if (typeof score !== 'number' || Number.isNaN(score)) continue;
      (buckets[dim] ??= []).push(score);
    }
    for (const dim of judgement.unscored_dims) unscoredSet.add(dim);
  }

  const dims: Record<string, number> = {};
  for (const [dim, scores] of Object.entries(buckets)) {
    const mean = scores.reduce((sum, v) => sum + v, 0) / scores.length;
    dims[dim] = toHalfStep(mean);
    // 某题没覆盖但另一题评上了分 → 不算 unscored
    unscoredSet.delete(dim);
  }

  return {
    dims,
    unscored: [...unscoredSet].sort(),
    judgedCount,
    trialCount: trials.length,
    paddingCount,
    avgConfidence:
      confidences.length > 0
        ? confidences.reduce((sum, v) => sum + v, 0) / confidences.length
        : null,
  };
}

/**
 * craft 维分 → 传给 /api/evaluate-stage 的 craftEvidence 文本。
 *
 * 只写进真实命中的 checkpoint 引文，不写「未命中」的空条目 ——
 * 证据栏的语义是「凭什么给这个分」，无引文即无证据。
 *
 * 边界（重要）：这里产出的是**裁判模型自己的引文**，属于展示用证据。
 * 它不会、也不应解除后端对 code_runnability / code_security 的 Q6 降权
 * （那需要 verifiedEvidence：真实执行/扫描结果）。
 * 让模型引文解除「缺真实执行则降权」，等于让被监管方给自己发合格证。
 */
export function buildCraftEvidence(trials: CraftTrialRound[]): Record<string, string> {
  const perDim: Record<string, string[]> = {};
  for (const trial of trials) {
    const judgement = trial.judgement;
    if (!judgement) continue;
    const quotes = judgement.checkpoints
      .filter((cp) => cp.hit && cp.quote.trim().length > 0)
      .map((cp) => `「${cp.quote.trim()}」`);
    if (quotes.length === 0) continue;
    for (const dim of Object.keys(judgement.dims)) {
      (perDim[dim] ??= []).push(`${trial.title}：${quotes.join('，')}`);
    }
  }
  const evidence: Record<string, string> = {};
  for (const [dim, list] of Object.entries(perDim)) {
    evidence[dim] = list.join(' ／ ').slice(0, 500);
  }
  return evidence;
}

/**
 * 汇总多轮试做题的**机器可核验**证据（沙盒真实执行结果）。
 *
 * 与 buildCraftEvidence 的分工是这套评测最重要的一条界线：
 * - buildCraftEvidence  → craftEvidence：裁判模型自己的引文，展示用，**不解除降权**；
 * - buildVerifiedEvidence → verifiedEvidence：机器跑出来的事实，**可解除 Q6 降权**。
 *
 * 同一维被多题验证时全部拼接（每条都是独立可复核的事实，不取均值也不择优）。
 * 沙盒未启用 / 没写测试 / 没抽到代码时后端不产出条目，这里自然为空 ——
 * 缺证据就该继续降权，这正是闸门存在的意义。
 */
export function buildVerifiedEvidence(trials: CraftTrialRound[]): Record<string, string> {
  const perDim: Record<string, string[]> = {};
  for (const trial of trials) {
    const verified = trial.judgement?.verified_evidence;
    if (!verified) continue;
    for (const [dim, text] of Object.entries(verified)) {
      const clean = String(text ?? '').trim();
      if (clean) (perDim[dim] ??= []).push(clean);
    }
  }
  const out: Record<string, string> = {};
  for (const [dim, list] of Object.entries(perDim)) {
    out[dim] = list.join(' ／ ').slice(0, 500);
  }
  return out;
}

/** 沙盒执行统计（UI 概览用：跑了几题、通过几题、有没有真的验证过） */
export interface SandboxSummary {
  /** 实际执行过用例的题数 */
  verifiedTasks: number;
  /** 其中全部通过的题数 */
  passedTasks: number;
  /** 其中存在失败用例的题数 */
  failedTasks: number;
  /** 因未写测试而无法验证的题数（≠ 验证不通过） */
  noTestTasks: number;
  /** 累计通过 / 累计用例数 */
  totalCases: number;
  passedCases: number;
}

export function summarizeSandbox(trials: CraftTrialRound[]): SandboxSummary {
  const summary: SandboxSummary = {
    verifiedTasks: 0,
    passedTasks: 0,
    failedTasks: 0,
    noTestTasks: 0,
    totalCases: 0,
    passedCases: 0,
  };
  for (const trial of trials) {
    const sandbox = trial.judgement?.sandbox;
    if (!sandbox) continue;
    if (sandbox.outcome === 'no_tests') summary.noTestTasks += 1;
    if (!sandbox.verifiable) continue;
    summary.verifiedTasks += 1;
    summary.totalCases += sandbox.total;
    summary.passedCases += sandbox.passed;
    if (sandbox.outcome === 'passed') summary.passedTasks += 1;
    else summary.failedTasks += 1;
  }
  return summary;
}
