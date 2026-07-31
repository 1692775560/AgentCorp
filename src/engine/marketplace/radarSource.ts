/**
 * src/engine/marketplace/radarSource.ts
 * 人才市场「六维三源解析层」（模块 A · 设计 §5.1）。
 *
 * 设计目标：`AgentSummary` / 市场模板卡本身没有六维，六维由本解析层按
 * 优先级从三个来源供给，卡片据此显示不同角标与动作：
 *
 *   1. evaluation —— `EvaluationProfile.radarLatest`（绩效域真相，角标「已评估」）
 *   2. prescreen  —— 最新 S1 `StageScore` 的六维客观项（角标「初审」）
 *   3. heuristic  —— persona / 模板元信息启发式种子（角标「预估」）
 *   4. none       —— 无任何来源，卡片显示「S1 初审」按钮
 *
 * 本文件全部为**纯函数、无副作用**：不读 store、不碰 electron-store、不发网络请求。
 * 所有数据（profile / stageScores / 启发式种子）由调用方（stores/marketplace.ts）注入，
 * 以保证可单测与离线可用。
 */
import type {
  EvaluationProfile,
  RadarScore,
  StageScore,
  Verdict,
} from '@/types/evaluation';
import { RADAR_DIMS } from '@/engine/scoring/registry';

/** 六维数据来源种类（供卡片角标：已评估 / 初审 / 预估 / 无） */
export type RadarSourceKind = 'evaluation' | 'prescreen' | 'heuristic' | 'none';

/** 六维解析结果（市场候选视图的能力面板数据源） */
export interface AgentRadarResolution {
  /** 六维分数（0–5）；null = 无任何来源，需触发 S1 初审 */
  radar: RadarScore | null;
  /** 数据来源（决定卡片角标与动作） */
  source: RadarSourceKind;
  /** S3 绩效评分卡 total（0–100），供绩效徽章与 matchScore.perfBoost */
  stageScoreTotal?: number;
  /** S3 判定（MVP / OBSERVE / FIRED） */
  verdict?: Verdict;
  /** 置信度（0–1，启发式/初审来源可选填） */
  confidence?: number;
}

/** 启发式种子入参（来自市场模板卡 / GitHub 导入卡的公开元信息） */
export interface HeuristicSeed {
  /** 展示名（仅用于长度类弱信号，不参与语义推断） */
  name?: string;
  /** 简介文本 */
  description?: string;
  /** 能力标签 */
  tags?: string[];
  /** 市场评分（0–5） */
  rating?: number;
  /** 报价数值（元/月，0 = 免费） */
  budgetNum?: number;
  /** 已雇佣数 */
  hiredCount?: number;
  /** 雇佣形态（团队通常任务承载力更强） */
  hireType?: 'single' | 'team';
  /** 团队成员 / 能力条目数 */
  capabilityCount?: number;
}

/** 解析层入参（三源全部由外部注入，保持纯函数） */
export interface RadarSourceInput {
  /** 评估域档案（已雇佣并跑过评估的 agent 才有） */
  profile?: EvaluationProfile | null;
  /** 该候选的历史阶段评分卡（S1/S2/S3 混合，内部按 stage + ts 择新） */
  stageScores?: StageScore[] | null;
  /** 启发式种子（模板卡 / GitHub 导入卡） */
  heuristic?: HeuristicSeed | null;
  /** 是否允许使用启发式兜底（默认 false：无真实数据时返回 none，引导用户点「S1 初审」） */
  allowHeuristic?: boolean;
}

/** 全零六维（内部判空用） */
const ZERO_RADAR: RadarScore = {
  task: 0,
  quality: 0,
  comm: 0,
  creativity: 0,
  reliability: 0,
  cost: 0,
};

/** 六维中文标签（卡片 / tooltip 复用，避免各处重复硬编码） */
export const RADAR_DIM_LABELS: Record<keyof RadarScore, string> = {
  task: '任务',
  quality: '质量',
  comm: '沟通',
  creativity: '创意',
  reliability: '可靠',
  cost: '性价比',
};

/** 数据来源中文角标文案 */
export const RADAR_SOURCE_LABELS: Record<RadarSourceKind, string> = {
  evaluation: '已评估',
  prescreen: '初审',
  heuristic: '预估',
  none: '未评估',
};

/** 夹取到 [0,5] 并对齐 0.5 步进（与主观打分同口径） */
export function clampToHalfStep(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.min(5, Math.max(0, value));
  return Math.round(clamped * 2) / 2;
}

/** 六维均值（0–5），null → 0 */
export function radarMean(radar: RadarScore | null | undefined): number {
  if (!radar) return 0;
  const sum = RADAR_DIMS.reduce((acc, dim) => acc + (radar[dim] ?? 0), 0);
  return sum / RADAR_DIMS.length;
}

/** 判断六维是否「有内容」（全零视为无效，避免占位档案污染排序） */
export function isMeaningfulRadar(radar: RadarScore | null | undefined): boolean {
  if (!radar) return false;
  return RADAR_DIMS.some((dim) => (radar[dim] ?? 0) > 0);
}

/**
 * 解析报价文本为数值（元）。
 * 支持「¥299/月」「299 元」「免费」「Free」等常见写法；无法解析时返回 0（视为免费）。
 */
export function parseBudgetNumber(price: string | null | undefined): number {
  if (!price) return 0;
  const text = String(price);
  if (/免费|free/i.test(text)) return 0;
  const matched = text.replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (!matched) return 0;
  const value = Number(matched[0]);
  return Number.isFinite(value) ? value : 0;
}

/** 从 StageScore 的客观项中抽取六维（缺维补 0） */
export function radarFromStageScore(stage: StageScore | null | undefined): RadarScore | null {
  if (!stage || !Array.isArray(stage.objective)) return null;
  const radar: RadarScore = { ...ZERO_RADAR };
  let hit = 0;
  for (const item of stage.objective) {
    const dim = item.dim as keyof RadarScore;
    if (RADAR_DIMS.includes(dim)) {
      radar[dim] = clampToHalfStep(item.score);
      hit += 1;
    }
  }
  return hit > 0 ? radar : null;
}

/** 取某阶段最新一张评分卡（按 ts 字典序比较，ISO8601 可直接比较） */
export function latestStageScore(
  stageScores: StageScore[] | null | undefined,
  stage: StageScore['stage'],
): StageScore | null {
  if (!stageScores || stageScores.length === 0) return null;
  let latest: StageScore | null = null;
  for (const s of stageScores) {
    if (s.stage !== stage) continue;
    if (!latest || String(s.ts) > String(latest.ts)) latest = s;
  }
  return latest;
}

/**
 * persona / 模板元信息 → 启发式六维（确定性，无随机）。
 *
 * 各维推导规则（弱信号，仅用于「没有任何真实评估数据」时的种子）：
 * - task：基线 3；团队 +0.5；能力条目 ≥3 +0.3；命中「全栈/自动化/独立」+0.3
 * - quality：以市场评分 rating 为主（rating × 0.9 + 0.4）
 * - comm：简介越充分、标签越多，沟通表达信号越强
 * - creativity：命中创作类标签（创意/设计/内容/文案/视频）显著加成
 * - reliability：已雇佣数分档（社会验证）
 * - cost：报价分档（免费 5 分 → 高价 2 分）
 */
export function heuristicRadar(seed: HeuristicSeed): RadarScore {
  const tags = seed.tags ?? [];
  const text = `${seed.name ?? ''} ${seed.description ?? ''} ${tags.join(' ')}`;
  const descLen = (seed.description ?? '').length;
  const rating = typeof seed.rating === 'number' ? seed.rating : 4;
  const hired = seed.hiredCount ?? 0;
  const budget = seed.budgetNum ?? 0;
  const capCount = seed.capabilityCount ?? 0;

  // task：任务承载力
  let task = 3;
  if (seed.hireType === 'team') task += 0.5;
  if (capCount >= 3) task += 0.3;
  if (/全栈|自动化|独立|端到端|一站式/.test(text)) task += 0.3;

  // quality：以市场评分为主信号
  const quality = rating * 0.9 + 0.4;

  // comm：简介充分度 + 标签丰富度
  let comm = 2.8;
  if (descLen >= 30) comm += 0.5;
  if (descLen >= 80) comm += 0.4;
  if (tags.length >= 3) comm += 0.3;
  if (/沟通|汇报|文档|解释|客服|翻译/.test(text)) comm += 0.5;

  // creativity：创作类信号
  let creativity = 2.8;
  if (/创意|设计|内容|文案|视频|海报|营销|增长/.test(text)) creativity += 1.0;
  if (/审美|风格|品牌/.test(text)) creativity += 0.4;

  // reliability：社会验证（已雇佣数分档）
  let reliability = 3;
  if (hired >= 50) reliability += 0.5;
  if (hired >= 200) reliability += 0.5;
  if (hired >= 1000) reliability += 0.5;
  if (/稳定|生产级|可靠|审查|测试/.test(text)) reliability += 0.3;

  // cost：报价分档
  let cost: number;
  if (budget <= 0) cost = 5;
  else if (budget <= 99) cost = 4.5;
  else if (budget <= 299) cost = 4;
  else if (budget <= 599) cost = 3.5;
  else if (budget <= 999) cost = 3;
  else cost = 2.5;

  return {
    task: clampToHalfStep(task),
    quality: clampToHalfStep(quality),
    comm: clampToHalfStep(comm),
    creativity: clampToHalfStep(creativity),
    reliability: clampToHalfStep(reliability),
    cost: clampToHalfStep(cost),
  };
}

/**
 * 三源解析主入口（设计 §5.1）。
 *
 * 无论走哪一源，都会尝试补齐 S3 绩效信息（stageScoreTotal / verdict），
 * 供卡片绩效徽章与 `matchScore.perfBoost`（通道 B：绩效分回流）使用。
 */
export function resolveAgentRadar(input: RadarSourceInput): AgentRadarResolution {
  const { profile, stageScores, heuristic, allowHeuristic = false } = input;

  // S3 绩效回流（与六维来源无关，能取则取）
  const perf = latestStageScore(stageScores, 'performance');
  const perfPatch: Pick<AgentRadarResolution, 'stageScoreTotal' | 'verdict'> = perf
    ? { stageScoreTotal: perf.total, verdict: perf.verdict }
    : {};

  // 源 1：评估域真相
  if (profile && isMeaningfulRadar(profile.radarLatest)) {
    return { radar: profile.radarLatest, source: 'evaluation', confidence: 1, ...perfPatch };
  }

  // 源 2：S1 初审评分卡
  const preScreen = latestStageScore(stageScores, 'preScreen');
  const preRadar = radarFromStageScore(preScreen);
  if (isMeaningfulRadar(preRadar)) {
    return { radar: preRadar, source: 'prescreen', confidence: 0.7, ...perfPatch };
  }

  // 源 3：启发式种子（默认关闭，由调用方显式开启）
  if (allowHeuristic && heuristic) {
    return { radar: heuristicRadar(heuristic), source: 'heuristic', confidence: 0.4, ...perfPatch };
  }

  // 源 4：无数据 → 卡片显示「S1 初审」按钮
  return { radar: null, source: 'none', ...perfPatch };
}

export default resolveAgentRadar;
