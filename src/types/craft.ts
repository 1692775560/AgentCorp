/**
 * src/types/craft.ts
 * 工种试做题（craft）契约层 —— 逐字段对齐 model-service 的
 * `app/scoring/craft_tasks.py` / `app/scoring/craft_judge.py`。
 *
 * 这条链路存在的理由：只看仓库 star 数的「初步印象」评分对个人上传的 agent
 * 系统性不公。试做题让所有候选做同一道题、走同一套 rubric，分数只取决于
 * 答案本身是否兑现了可核验要点。
 */

/** 一道试做题（题库不含参考答案，防刷题） */
export interface CraftTask {
  id: string;
  /** 与后端 registry 键一致：image / text / code */
  job_type: string;
  title: string;
  prompt: string;
  /** 本题重点考查的 craft 维 */
  target_dims: string[];
  /** 可核验要点，裁判逐条判定兑现与否 */
  checkpoints: string[];
}

/** 单条要点的判定结果 */
export interface CheckpointVerdict {
  checkpoint: string;
  hit: boolean;
  /** 支持该判定的答案原文片段；空串视为无证据 */
  quote: string;
}

/** 一道试做题的裁判结果 */
export interface CraftJudgement {
  task_id: string;
  job_type: string;
  /** craft 维 → 分数（0–5，0.5 步进），仅含本题 target_dims */
  dims: Record<string, number>;
  /** 未被本题覆盖、因此不可评的维度（不补 0，避免「没考到」看起来像「考了但不好」） */
  unscored_dims: string[];
  checkpoints: CheckpointVerdict[];
  /** 空口承诺检测：题面探针命中即为 true */
  padding_detected: boolean;
  padding_note: string;
  confidence: number;
  /** 是否采用参考答案锚定 */
  reference_used: boolean;
  /** 首 token 时延（ms），大赛 TTFT 口径 */
  ttft_ms: number | null;
  latency_ms: number;
  backend: string;
}

/** 评分入参 */
export interface CraftJudgeInput {
  task_id: string;
  answer?: string;
  candidate?: Record<string, unknown>;
}
