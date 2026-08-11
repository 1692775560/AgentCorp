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
import type {
  CandidateProfile,
  JobType,
  MediaRef,
  RadarDim,
  RadarScore,
} from "./evaluation";
import type { AgentRadarResolution } from "@/engine/marketplace/radarSource";

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

/* ===================== 智能匹配增量（模块 A · 设计 §5.2，仅加法） ===================== */

/**
 * 任务需求（市场页输入，同时流向 HR 面试的考查维度与市场排序）。
 * 这是「模糊高维状态 → 可操作目标」收敛链路的第一个显式载体。
 */
export interface TaskRequirement {
  /** 自然语言需求，如「要一个稳定又便宜的后端 agent」 */
  text: string;
  /** 期望工种（UI 显式选择，'all' = 不限） */
  jobType: JobType | "all";
  /** 需求关键词标签（taskMatch 派生 + 用户手改） */
  tags: string[];
}

/** taskMatch.ts 派生的任务画像（排序输入） */
export interface TaskProfile {
  /** 文本推断 / 显式选择的工种（null = 不限） */
  jobType: JobType | null;
  /** 维度强调系数（缺省视为 1） */
  dimBoost: Partial<Record<RadarDim, number>>;
  /** 需求标签（Jaccard 匹配用） */
  tags: string[];
}

/** 匹配分分解（MatchScoreBadge tooltip 用） */
export interface MatchScoreBreakdown {
  /** 0–100 匹配总分 */
  total: number;
  /** 0–1，六维加权契合（含心智权重 × 任务强调） */
  userFit: number;
  /** 0–1，标签 Jaccard */
  tagMatch: number;
  /** 0–1，性价比归一 */
  costPerf: number;
  /** 0–1，S3 绩效回流（无绩效 = 0.5 中性） */
  perfBoost: number;
  /** 四项权重（默认 0.5 / 0.2 / 0.15 / 0.15） */
  weights: { fit: number; tag: number; cost: number; perf: number };
  /** D · 个性化强调系数（老板原型 boost）；非空表示本次匹配按「与谁协作」个性化 */
  personaBoost?: Partial<Record<RadarDim, number>>;
}

/** 市场候选统一视图（模板卡 / 已雇佣 agent / GitHub 导入 三源归一） */
export interface MarketCandidateView {
  /** templateId 或 agentId */
  id: string;
  /** 已雇佣时存在（可读评估域档案与阶段评分卡） */
  agentId?: string;
  name: string;
  description: string;
  tags: string[];
  hireType: "single" | "team";
  /** 报价原文（展示用） */
  price: string;
  /** 报价数值（排序/性价比用） */
  budgetNum: number;
  avatar: string;
  rating: number;
  hiredCount: number;
  /** 工种（文本推断，null = 未知） */
  jobType: JobType | null;
  /** 六维三源解析结果（设计 §5.1） */
  radarResolution: AgentRadarResolution;
  /** 匹配分解；无六维时为 undefined（排序沉底） */
  match?: MatchScoreBreakdown;
  /** 小红心点赞装配字段（reactionStore 读取，视图层展示用） */
  likeCount?: number;
  likedByMe?: boolean;
  /** BossFavorite 装配字段（同工种赛道内名次，1 = 最受青睐） */
  favoriteRank?: number;
  favoriteCount?: number;
}
