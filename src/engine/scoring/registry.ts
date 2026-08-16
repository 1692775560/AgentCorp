/**
 * src/engine/scoring/registry.ts
 * 维度注册表（T0 前端 TS 镜像，与 model-service/app/scoring/registry.py 同义）。
 *
 * 设计要点：
 * - 六维基线 RADAR_DIMS 复用既有 RadarDim（src/types/evaluation.ts）。
 * - 前缀隔离：craft 维 img_* / txt_* / code_*；主观维 sub_*。
 * - JobType / StageKey / SubjectiveDim / CraftDim 类型严格照搬。
 * - craftLinks(dim) 为偏好回灌提供 craft→通用六维映射。
 */
import type { RadarDim } from "../../types/evaluation";

/** 六维基线（与后端 RADAR_DIMS / 前端 RadarDim 同源） */
export const RADAR_DIMS: RadarDim[] = [
  "task",
  "quality",
  "comm",
  "creativity",
  "reliability",
  "cost",
];

/** 工种（Q2 权重差异化） */
export type JobType = "image" | "text" | "code";

/** 阶段键（S1/S2/S3） */
export type StageKey = "preScreen" | "interview" | "performance";

/** 主观维度（分阶段启用*/
export type SubjectiveDim =
  | "sub_potential"
  | "sub_aesthetic_lean"
  | "sub_task_feel"
  | "sub_communication"
  | "sub_surprise"
  | "sub_trust"
  | "sub_rehire";

/** 工种 craft 维度（前缀隔离*/
export type CraftDim =
  | "img_composition"
  | "img_style_fit"
  | "img_fidelity"
  | "img_aesthetic_consistency"
  | "img_multimodal_follow"
  | "txt_factuality"
  | "txt_coherence"
  | "txt_tone_fit"
  | "txt_info_density"
  | "txt_instruction_follow"
  | "code_runnability"
  | "code_efficiency"
  | "code_test_coverage"
  | "code_maintainability"
  | "code_security";

/** craft 维元数据 */
export interface CraftDimMeta {
  key: CraftDim;
  jobType: JobType;
  links: RadarDim[]; // 关联通用六维（回灌/加权）
  requiresReal: boolean; // Q6：code_runnability/code_security = true
  anchor: { 0: string; 3: string; 5: string }; // 0–5 锚点
}

/** 工种 → craft 维度列表（JOB_CRAFT_DIMS） */
export const JOB_CRAFT_DIMS: Record<JobType, CraftDim[]> = {
  image: [
    "img_composition",
    "img_style_fit",
    "img_fidelity",
    "img_aesthetic_consistency",
    "img_multimodal_follow",
  ],
  text: [
    "txt_factuality",
    "txt_coherence",
    "txt_tone_fit",
    "txt_info_density",
    "txt_instruction_follow",
  ],
  code: [
    "code_runnability",
    "code_efficiency",
    "code_test_coverage",
    "code_maintainability",
    "code_security",
  ],
};

/** 阶段 → 启用主观维度（SUBJECTIVE_DIMS） */
export const SUBJECTIVE_DIMS: Record<StageKey, SubjectiveDim[]> = {
  preScreen: ["sub_potential", "sub_aesthetic_lean"],
  interview: ["sub_task_feel", "sub_communication", "sub_surprise"],
  performance: ["sub_trust", "sub_rehire", "sub_aesthetic_lean"],
};

/** 工种通用六维权重（Q2，Σ=1，仅通用六维内部*/
export const JOB_GENERIC_WEIGHT: Record<JobType, Record<RadarDim, number>> = {
  image: { task: 0.18, quality: 0.17, comm: 0.15, creativity: 0.17, reliability: 0.17, cost: 0.16 },
  text: { task: 0.18, quality: 0.17, comm: 0.18, creativity: 0.12, reliability: 0.18, cost: 0.17 },
  code: { task: 0.18, quality: 0.17, comm: 0.12, creativity: 0.13, reliability: 0.2, cost: 0.2 },
};

/** Q6 强制真实执行/扫描标记（CRAFT_REQUIRES_REAL） */
export const CRAFT_REQUIRES_REAL: Partial<Record<CraftDim, boolean>> = {
  code_runnability: true,
  code_security: true,
};

/** craft 维 → 关联通用六维（CRAFT_LINKS*/
export const CRAFT_LINKS: Record<CraftDim, RadarDim[]> = {
  img_composition: ["quality", "creativity"],
  img_style_fit: ["quality", "task"],
  img_fidelity: ["quality", "reliability"],
  img_aesthetic_consistency: ["creativity", "quality"],
  img_multimodal_follow: ["task", "reliability"],
  txt_factuality: ["reliability", "quality"],
  txt_coherence: ["quality", "comm"],
  txt_tone_fit: ["comm", "quality"],
  txt_info_density: ["comm", "creativity"],
  txt_instruction_follow: ["task", "reliability"],
  code_runnability: ["task", "reliability"],
  code_efficiency: ["cost", "quality"],
  code_test_coverage: ["reliability", "quality"],
  code_maintainability: ["quality", "creativity"],
  code_security: ["reliability", "cost"],
};

/** craft 维 → 关联通用六维（偏好回灌用，镜像后端 craft_links） */
export function craftLinks(dim: CraftDim | string): RadarDim[] {
  return (CRAFT_LINKS as Record<string, RadarDim[]>)[dim] ?? [];
}

/** 由 craft 维前缀推断工种（镜像后端 job_type_of_craft） */
export function jobTypeOfCraft(dim: string): JobType {
  if (dim.startsWith("img_")) return "image";
  if (dim.startsWith("txt_")) return "text";
  if (dim.startsWith("code_")) return "code";
  return "code";
}
