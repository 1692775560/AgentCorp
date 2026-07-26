/**
 * src/types/marketplace.ts
 * 人才市场契约层（增量 · 架构 §3.1 / PRD §4.1）。
 *
 * 全部类型在既有 CandidateProfile 之上组合扩展，保证 Mock 与真实契约同源
 * （「单一真相源」继承）：initial_review.radar 与 evaluation.radar 同为六维。
 *
 * 本期增量（GitHub 一键导入真实 Agent）：
 * - `AgentSource` 增加 `'github_import'`（纯增量 union，零风险）。
 * - 新增 `GithubImportMeta` 承载 ⭐/协议/html_url/分支/派生报价等 GitHub 专属展示字段。
 * - `MarketplaceAgent` 增加可选 `github_meta`，仅 `github_import` 来源填充。
 */
import type { CandidateProfile, MediaRef, RadarScore } from "./evaluation";

/** 职能分类（市场筛选用） */
export type AgentFunction =
  | "制图"
  | "短视频"
  | "文案"
  | "前端"
  | "后端"
  | "全栈"
  | "数据分析";

/** agent 来源：市场 Mock 样例 / 用户上传 / GitHub 导入（本期新增） */
export type AgentSource = "market_mock" | "user_upload" | "github_import";

/** 六维初审结论（阶段二快速审阅产出，轻于绩效终审 verdict） */
export type QuickVerdict = "PASS" | "OBSERVE" | "REJECT";

/** 六维初审结果（阶段二快速审阅产出，轻于深度评估） */
export interface InitialReview {
  radar: RadarScore; // 复用既有六维（0–5）
  tag_eval: string[]; // tag 评价，如 ["后端·CodeAct","MIT 可商用","⭐69k 高人气"]
  quick_verdict: QuickVerdict; // 初审结论（非绩效终审）
  confidence: number; // 0–1
}

/**
 * GitHub 导入元信息（仅 source==='github_import' 时填充）。
 * 供卡片角标 / 协议标 / 作品集直链 / 派生报价展示，Mock 卡不填。
 */
export interface GithubImportMeta {
  owner: string; // 如 "All-Hands-AI"
  repo: string; // 如 "OpenHands"
  stars: number; // ⭐ 角标 + 推导报价
  forks: number;
  license: string; // spdx_id 或 "自定义/未声明"
  html_url: string; // https://github.com/<owner>/<repo>
  branch: string; // 默认分支（raw 直链用）
  pushed_at: string; // ISO，可靠性评分 + 活跃度
  language: string | null; // 主语言
  notional_budget: number; // clamp(round(stars/2000)+100, 80, 320) 推导报价
  commercial_review: boolean; // license 非宽松 → 标红「商用需复核」
}

/** 人才市场列表项（在 CandidateProfile 之上叠加展示字段） */
export interface MarketplaceAgent {
  profile: CandidateProfile; // 复用既有候选档案（多模态证据 + evaluation）
  agent_function: AgentFunction; // 职能分类（筛选用）
  style_tags: string[]; // 风格 tag（如 极简/memphis/赛博朋克）
  source: AgentSource; // 来源（本期新增 'github_import'）
  avatar_url?: string; // 头像（取 owner.avatar_url，仅存不强制渲染，避免外链裂图）
  work_thumbnails: MediaRef[]; // 作品缩略（复用 artwork）
  initial_review?: InitialReview; // 六维初审（P0-4），Mock 预置直显
  /** GitHub 导入专用元信息（Mock 卡不填） */
  github_meta?: GithubImportMeta;
}

/** 市场筛选/排序状态 */
export interface MarketFilters {
  search: string; // 关键词（名字/tag）
  function: AgentFunction | "all";
  style: string | "all";
  maxBudget: number | null; // 报价 ≤ X
  sort: "review" | "budget" | "costperf"; // 初审分 / 报价 / 性价比
}
