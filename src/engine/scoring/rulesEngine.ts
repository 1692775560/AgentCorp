/**
 * src/engine/scoring/rulesEngine.ts
 * 规则引擎（T1 前端 TS 镜像，与 model-service/app/scoring/rules_engine.py 同公式）。
 *
 * 前端可离线计算（无需后端），公式与后端严格一致。
 * 零新增依赖（纯 TS）。
 */
import type { JobType, StageKey, SubjectiveDim, CraftDim } from "./registry";
import { JOB_GENERIC_WEIGHT } from "./registry";

/** 规则 JSON 的类型（与 presets/default.json 同构*/
export interface ScoringRules {
  $schema?: string;
  version?: string;
  presetId?: string;
  genericRadar?: string[];
  jobs: Record<JobType, { craftDims: CraftDim[] }>;
  stages: Record<
    StageKey,
    {
      enabledObjective?: string[];
      enabledSubjective?: SubjectiveDim[];
      objectiveBlockWeight: { generic: number; craft: number; kpiRoi?: number };
      objectiveWeight: number;
      subjectiveWeight: number;
      genericRadarWeight: Record<string, number>;
      thresholds?: { mvp: number; observe: number };
    }
  >;
  subjective?: { capPercent?: number; neutralBaseline?: number };
}

/** 由 objective 中的 craft 维前缀推断工种（无 craft 维默认 code） */
export function detectJobType(objective: Record<string, number>): JobType {
  for (const dim of Object.keys(objective)) {
    if (dim.startsWith("img_")) return "image";
    if (dim.startsWith("txt_")) return "text";
    if (dim.startsWith("code_")) return "code";
  }
  return "code";
}

/** 权重预折叠（镜像后端 flatten_dim_weight*/
export function flattenDimWeight(
  stage: StageKey,
  jobType: JobType,
  rules: ScoringRules,
): Record<string, number> {
  const stageCfg = rules.stages[stage];
  const bw = stageCfg.objectiveBlockWeight;
  const genericBlock = bw.generic ?? 0;
  const craftBlock = bw.craft ?? 0;

  const craftDims = rules.jobs[jobType]?.craftDims ?? [];

  // generic 六维权重：优先按工种差异化（Q2，JOB_GENERIC_WEIGHT[jobType]），
  // 缺失时回退阶段级 genericRadarWeight
  const genericW =
    (JOB_GENERIC_WEIGHT as Record<string, Record<string, number>>)[jobType] ??
    stageCfg.genericRadarWeight;

  const raw: Record<string, number> = {};
  // generic 块
  for (const [dim, w] of Object.entries(genericW)) {
    raw[dim] = w * genericBlock;
  }
  // craft 块（均分）
  if (craftDims.length > 0) {
    const per = craftBlock / craftDims.length;
    for (const d of craftDims) raw[d] = per;
  }
  // kpiRoi 块：本批次占位（无维度），归一时自动重分配其份额

  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  if (total <= 0) return raw;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v / total;
  return out;
}

/** verdict 映射（Q4，镜像后端 verdict_from_total） */
export function verdictFromTotal(
  total: number,
  rules?: ScoringRules,
  stage?: StageKey,
): "MVP" | "OBSERVE" | "FIRED" {
  let mvp = 78;
  let observe = 50;
  if (rules && stage && rules.stages[stage]?.thresholds) {
    mvp = rules.stages[stage].thresholds!.mvp ?? mvp;
    observe = rules.stages[stage].thresholds!.observe ?? observe;
  }
  if (total >= mvp) return "MVP";
  if (total >= observe) return "OBSERVE";
  return "FIRED";
}

/** 阶段计分（镜像后端 compute_stage_score*/
export function computeStageScore(
  objective: Record<string, number>,
  subjective: Record<string, number>,
  rules: ScoringRules,
  stage: StageKey,
  jobType?: JobType,
): {
  objectiveScore: number;
  subjectiveScore: number;
  total: number;
  verdict: "MVP" | "OBSERVE" | "FIRED";
  jobType: JobType;
  stage: StageKey;
  dimWeight: Record<string, number>;
} {
  const jt = jobType ?? detectJobType(objective);
  const stageCfg = rules.stages[stage];
  const dimWeight = flattenDimWeight(stage, jt, rules);

  // 客观分（加权）
  let objAcc = 0;
  for (const [dim, w] of Object.entries(dimWeight)) {
    const score = objective[dim] ?? 0;
    objAcc += (score / 5) * w;
  }
  const objectiveScore = Math.round(objAcc * 100 * 10) / 10;

  // 主观分（等权）
  const subDims = stageCfg.enabledSubjective ?? [];
  const nSub = subDims.length || 1;
  let subAcc = 0;
  for (const d of subDims) {
    const score = subjective[d] ?? 0;
    subAcc += (score / 5) * (1 / nSub);
  }
  const subjectiveScore = Math.round(subAcc * 100 * 10) / 10;

  // 总分
  const ow = stageCfg.objectiveWeight ?? 0.5;
  const sw = stageCfg.subjectiveWeight ?? 0.5;
  const total = Math.round((objectiveScore * ow + subjectiveScore * sw) * 10) / 10;

  const verdict = verdictFromTotal(total, rules, stage);

  return {
    objectiveScore,
    subjectiveScore,
    total,
    verdict,
    jobType: jt,
    stage,
    dimWeight,
  };
}
