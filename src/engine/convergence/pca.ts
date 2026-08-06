/**
 * src/engine/convergence/pca.ts
 * 纯 TS 的 2D PCA（幂迭代前 2 主成分，确定性可复现）。
 *
 * 严格镜像 model-service/app/scoring/encoder.py 的 pca2d（不引 numpy / 任何依赖）：
 *   - 中心化；
 *   - 协方差 C = XᵀX / N；
 *   - 幂迭代求第 1 主成分 v1（固定初始向量 e1）；
 *   - 减秩（C2 = C − (v1ᵀCv1)·v1v1ᵀ）后幂迭代求 v2（初始 e2，避免收敛到同一向量）；
 *   - 各点投影到 (v1, v2)。
 *
 * 边界：空输入 → []；单点 → [[0,0]]；全相同点 → 投影全为 [0,0]（确定性）。
 *
 * 用途（T18 可视化）：把后端回传的 belief / 候选 embedding 投影到 2D 画轨迹。
 */
import type { CandidateEmbedding, ConvergenceTrace, HumanAnchor, TurnState } from '@/types/convergence';

/** 矩阵 × 向量（M 为 d×d，v 为 d 维） */
function matVec(M: number[][], v: number[]): number[] {
  return M.map((row) => row.reduce((s, x, i) => s + x * v[i], 0));
}

/** 点积 */
function dot(a: number[], b: number[]): number {
  return a.reduce((s, x, i) => s + x * b[i], 0);
}

/** 幂迭代求主特征向量：固定迭代次数 + 固定初始向量 → 可复现。 */
function powerIterate(C: number[][], init: number[], nIter = 100): number[] {
  let v = init.slice();
  const n0 = Math.hypot(...v) || 0;
  v = n0 > 0 ? v.map((x) => x / n0) : v;
  for (let _ = 0; _ < nIter; _++) {
    v = matVec(C, v);
    const nv = Math.hypot(...v) || 0;
    if (nv === 0) break;
    v = v.map((x) => x / nv);
  }
  return v;
}

/**
 * 把 N 个 d 维向量投影到 2D（前 2 主成分），返回 [[x,y], ...]。
 * 与后端 pca2d 逐位一致（同输入同输出）。
 */
export function pca2d(vectors: number[][]): Array<[number, number]> {
  const n = vectors.length;
  if (n === 0) return [];
  if (n === 1) return [[0, 0]];

  const d = vectors[0].length;
  // 中心化
  const mean = new Array(d).fill(0);
  for (const v of vectors) for (let j = 0; j < d; j++) mean[j] += v[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  const X = vectors.map((v) => v.map((x, j) => x - mean[j]));

  // 协方差矩阵 C = Xᵀ X / n （d×d）
  const C: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));
  for (let a = 0; a < d; a++) {
    for (let b = 0; b < d; b++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += X[i][a] * X[i][b];
      C[a][b] = s / n;
    }
  }

  // 第 1 主成分（初始向量 e1 = [1,0,...,0]）
  const v1 = powerIterate(C, [1, ...new Array(d - 1).fill(0)]);

  // 减秩后求第 2 主成分（初始向量 e2 = [0,1,0,...,0]）
  const lambda1 = dot(v1, matVec(C, v1));
  const C2: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));
  for (let a = 0; a < d; a++) {
    for (let b = 0; b < d; b++) {
      C2[a][b] = C[a][b] - lambda1 * v1[a] * v1[b];
    }
  }
  const v2 = powerIterate(C2, [0, 1, ...new Array(d - 2).fill(0)]);

  // 投影
  return X.map((row) => [dot(row, v1), dot(row, v2)] as [number, number]);
}

// ======================================================================
// 通用数值工具（与后端 clamp/l2_norm/cosine_similarity/std_pop 镜像）
// ======================================================================
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function l2Norm(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const na = l2Norm(a);
  const nb = l2Norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

export function stdPop(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const m = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - m) * (v - m), 0) / n;
  return Math.sqrt(variance);
}

// ======================================================================
// 轨迹 → 2D PCA 投影（供 T18 可视化）
// ======================================================================

/** 投影点（含语义标注） */
export interface PcaPoint {
  id: string;
  x: number;
  y: number;
  kind: 'belief' | 'candidate' | 'anchor';
  label: string;
  turn: number;
  embedding: number[];
}

/**
 * 将一条收敛轨迹投影到 2D PCA 平面。
 * 投影集合：每轮 belief_embedding（标注 S₀/TurnN）+ 每轮候选 embedding +
 * 若已锚定则追加锚点 embedding（取 human_anchor_id 对应候选的 embedding）。
 *
 * 返回 { points, beliefs, anchorXY? }：
 *   - points：全部投影点（散点）；
 *   - beliefs：按 turn 排序的 belief 投影点（画 S₀→…→S_K 折线）；
 *   - anchorXY：锚点 2D 坐标（画末轮 belief → 锚点的残差连线）。
 */
export function projectTraceToPca(
  trace: ConvergenceTrace,
  anchor?: HumanAnchor | null,
): { points: PcaPoint[]; beliefs: PcaPoint[]; anchorXY: [number, number] | null } {
  const points: PcaPoint[] = [];
  const beliefs: PcaPoint[] = [];

  // 收集所有向量以统一 PCA 基
  const allVecs: number[][] = [];
  const meta: Array<{ kind: PcaPoint['kind']; label: string; turn: number; emb: number[]; id: string }> = [];

  for (const t of [...trace.turns].sort((a, b) => a.turn - b.turn)) {
    const beliefLabel = t.turn === 0 ? 'S₀' : `Turn${t.turn}`;
    allVecs.push(t.belief_embedding);
    meta.push({
      kind: 'belief',
      label: beliefLabel,
      turn: t.turn,
      emb: t.belief_embedding,
      id: `belief-${t.turn}`,
    });
    for (const c of t.candidates) {
      allVecs.push(c.embedding);
      meta.push({
        kind: 'candidate',
        label: c.summary_text.slice(0, 24),
        turn: t.turn,
        emb: c.embedding,
        id: c.candidate_id,
      });
    }
  }

  // 锚点：优先用显式传入的 anchor.embedding；否则用轨迹内 human_anchor_id 对应候选
  let anchorVec: number[] | null = anchor ? anchor.embedding : null;
  if (!anchorVec && trace.human_anchor_id) {
    const cand = findCandidate(trace, trace.human_anchor_id);
    anchorVec = cand ? cand.embedding : null;
  }
  let anchorXY: [number, number] | null = null;
  if (anchorVec) {
    allVecs.push(anchorVec);
    meta.push({
      kind: 'anchor',
      label: 'Anchor',
      turn: -1,
      emb: anchorVec,
      id: 'anchor',
    });
  }

  const proj = pca2d(allVecs);
  meta.forEach((m, i) => {
    const p: PcaPoint = {
      id: m.id,
      x: proj[i][0],
      y: proj[i][1],
      kind: m.kind,
      label: m.label,
      turn: m.turn,
      embedding: m.emb,
    };
    points.push(p);
    if (m.kind === 'belief') beliefs.push(p);
    if (m.kind === 'anchor') anchorXY = [p.x, p.y];
  });

  return { points, beliefs: beliefs.sort((a, b) => a.turn - b.turn), anchorXY };
}

function findCandidate(trace: ConvergenceTrace, candidateId: string): CandidateEmbedding | null {
  for (const t of trace.turns) {
    const c = t.candidates.find((cc) => cc.candidate_id === candidateId);
    if (c) return c;
  }
  return null;
}

/** 取按 turn 排序的 belief embedding 序列（S₀..K），供 PCA 投影。 */
export function selectBeliefSequence(trace: ConvergenceTrace): number[][] {
  return [...trace.turns]
    .sort((a, b) => a.turn - b.turn)
    .map((t) => t.belief_embedding);
}

/** 取轨迹已锚定候选的 embedding（human_anchor_id 指向的候选）。 */
export function selectAnchorEmbedding(trace: ConvergenceTrace): number[] | null {
  if (!trace.human_anchor_id) return null;
  const c = findCandidate(trace, trace.human_anchor_id);
  return c ? c.embedding : null;
}

export type { TurnState };
