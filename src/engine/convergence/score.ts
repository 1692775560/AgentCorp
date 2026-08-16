/**
 * src/engine/convergence/score.ts
 * 收敛评分前端镜像 —— 严格对齐后端
 * model-service/app/scoring/convergence.py 的 compute_convergence_score
 * 与 公式（R3 对拍要求：前后端公式逐位一致）。
 *
 *   CR  = 1 − |S_K| / |S_0|
 *   R   = clamp( ||e_K − e_anchor|| / scale , 0, 1)
 *   St  = clamp( 1 − std( align(e_t, e_anchor) ) / 1.0 , 0, 1)
 *   CQ  = 1 if (anchor_candidate ∈ candidate_set_K) else 0
 *   convergence_score = 100 · ( w1·CR + w2·(1−R) + w3·St )
 *   Reversibility = mean_t( clamp(n_candidates_t / 3, 0, 1) )
 *                  末轮前坍缩到 1 候选施加 COLLAPSE_PENALTY=0.5 惩罚。
 *
 * 兜底（未锚定 / 锚点候选不在轨迹）：R=null, St=null, CQ=0，
 *   score 仅由收缩率贡献（100·w1·CR），明确标注「未获人类背书」。
 *   R/St 用 null 而非 0 —— 0 会被读成「完美对齐」（A3）。
 */
import { clamp, cosineSimilarity, l2Norm, stdPop } from './pca';
import type { ConvergenceTrace, ConvergenceScore, ConvSource } from '@/types/convergence';

/** 收敛可配参数（与后端 ConvergenceConfig 默认值严格一致） */
export interface ConvergenceConfigLike {
  k: number;
  w1: number;
  w2: number;
  w3: number;
  scale: number;
}

export const DEFAULT_CONVERGENCE_CONFIG: ConvergenceConfigLike = {
  k: 3,
  w1: 0.4,
  w2: 0.4,
  w3: 0.2,
  scale: 2.0,
};

/** 末轮前坍缩到 1 候选的惩罚系数（与后端 COLLAPSE_PENALTY 一致） */
export const COLLAPSE_PENALTY = 0.5;

/**
 * 语义收缩 SC 的权重（与后端 W_SEMANTIC 一致）。
 *
 * 从收缩族内部切分：CR 得 `w1 − 0.25`、SC 得 0.25。SC 不可用时权重回落
 * 给同族 CR（得完整 w1），故旧 trace 分数逐位不变 —— 这是「走法一：
 * 向后兼容优先」的数学保证，不可改为摊给对齐族。
 */
export const W_SEMANTIC = 0.25;

function findCandidateEmbedding(
  trace: ConvergenceTrace,
  candidateId: string,
): number[] | null {
  for (const t of trace.turns) {
    const c = t.candidates.find((cc) => cc.candidate_id === candidateId);
    if (c) return c.embedding;
  }
  return null;
}

function sortedTurns(trace: ConvergenceTrace) {
  return [...trace.turns].sort((a, b) => a.turn - b.turn);
}

/**
 * 计算收敛评分（与后端逐位一致）。
 * @param trace 收敛轨迹
 * @param config 可选权重/scale（缺省用 DEFAULT_CONVERGENCE_CONFIG）
 */
export function computeConvergenceScore(
  trace: ConvergenceTrace,
  config: ConvergenceConfigLike = DEFAULT_CONVERGENCE_CONFIG,
): ConvergenceScore {
  const turns = sortedTurns(trace);
  if (turns.length === 0) {
    throw new Error('computeConvergenceScore 需要至少 1 个 turn');
  }
  const w = { w1: config.w1, w2: config.w2, w3: config.w3 };

  const s0 = turns[0];
  const sK = turns[turns.length - 1];
  const n0 = s0.candidates.length;
  const nK = sK.candidates.length;
  const cr = n0 > 0 ? 1 - nK / n0 : 0;

  const beliefs = turns.map((t) => t.belief_embedding);

  // 锚点定位
  const anchorId = trace.anchor_candidate_id ?? undefined;
  let anchored = false;
  let eAnchor: number[] | null = null;
  if (anchorId) {
    eAnchor = findCandidateEmbedding(trace, anchorId);
    anchored = eAnchor !== null;
  }

  // 语义收缩 SC = clamp(1 − |U_K|/|U_0|, 0, 1)。
  // |U_0|==0 → null（「没算」），**不给满分** —— 防「不填 unknowns 反拿满分」。
  const u0Count = s0.unknowns?.length ?? 0;
  const uKCount = sK.unknowns?.length ?? 0;
  const sc: number | null = u0Count > 0 ? clamp(1 - uKCount / u0Count, 0, 1) : null;
  // delta 据实记录，允许负数（负 = 已消解，正 = 新发现未知，是真实信号）
  const unknownsDelta = uKCount - u0Count;

  let r: number | null;
  let st: number | null;
  let cq: number;

  // 同族按现存项重新归一化（与后端 _weighted_score 逐位一致）：
  // 收缩族 CR/SC、对齐族 (1−R)/St，任一项不可用即从分母剔除其权重。
  // SC 不可用时权重回落给同族 CR（得完整 w1）→ 旧分数逐位不变。
  const terms: Array<[number, number]> = [];
  if (sc === null) {
    terms.push([w.w1, cr]);
  } else {
    terms.push([w.w1 - W_SEMANTIC, cr], [W_SEMANTIC, sc]);
  }

  if (anchored && eAnchor) {
    const eK = sK.belief_embedding;
    assertSameDim(eK, eAnchor);
    const dist = l2Norm(eK.map((x, i) => x - eAnchor[i]));
    r = clamp(dist / config.scale, 0, 1);
    const aligns = beliefs.map((b) => cosineSimilarity(b, eAnchor!));
    st = clamp(1 - stdPop(aligns) / 1.0, 0, 1);
    const lastIds = new Set(sK.candidates.map((c) => c.candidate_id));
    cq = lastIds.has(anchorId!) ? 1 : 0;
    terms.push([w.w2, 1 - r], [w.w3, st]);
  } else {
    // 兜底：未锚定 —— R/St 未参与评分，置 null 而非 0
    r = null;
    st = null;
    cq = 0;
  }

  const denom = terms.reduce((s, [weight]) => s + weight, 0);
  const score =
    denom > 0 ? (100 * terms.reduce((s, [weight, value]) => s + weight * value, 0)) / denom : 0;

  // 可逆性
  const perTurn = turns.map((t) => clamp(t.candidates.length / 3, 0, 1));
  let rev = perTurn.length ? perTurn.reduce((s, x) => s + x, 0) / perTurn.length : 0;
  // 惩罚：末轮之前出现坍缩到 1 候选
  for (let idx = 0; idx < turns.length - 1; idx++) {
    if (turns[idx].candidates.length === 1) {
      rev *= COLLAPSE_PENALTY;
      break;
    }
  }
  rev = clamp(rev, 0, 1);

  // 来源标注：任一轮为投影/合成，整条分数即为投影/合成（A2）。
  // 取「或」而非「且」—— 掺了一轮假数据，这个分数就不能当实测用。
  const source: 'projected' | 'measured' = turns.some((t) => t.source === 'projected')
    ? 'projected'
    : 'measured';
  const synthetic = turns.some((t) => t.synthetic === true);

  return {
    run_id: trace.run_id,
    agent_id: trace.agent_id,
    contraction_rate: round6(cr),
    residual: r === null ? null : round6(r),
    stability: st === null ? null : round6(st),
    convergence_score: round4(score),
    reversibility: round6(rev),
    convergence_quality: cq as 0 | 1,
    // SC 未计算时出参填 0.0 保数值契约（toFixed/Number 不崩），
    // 「没算」与「一项未消解」靠 semantic_scored 区分 —— 下游禁止 `is null` 判断。
    semantic_contraction: sc === null ? 0 : round6(sc),
    semantic_scored: sc !== null,
    unknowns_delta: unknownsDelta,
    weights: { w1: w.w1, w2: w.w2, w3: w.w3 },
    ts: new Date().toISOString(),
    source,
    synthetic,
  };
}

/** 维度不等直接抛错：zip/map 会静默截断，让维度 bug 一路潜行到分数里（A4）。 */
function assertSameDim(a: number[], b: number[]): void {
  if (a.length !== b.length) {
    throw new Error(
      `收敛评分维度不匹配：belief=${a.length} anchor=${b.length}（须同维）`,
    );
  }
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

export type { ConvSource };
