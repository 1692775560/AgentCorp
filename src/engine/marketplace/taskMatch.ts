/**
 * src/engine/marketplace/taskMatch.ts
 * 任务画像抽取（模块 A · 设计 §6 Step 1）。
 *
 * 需求自然语言文本 → `TaskProfile`（jobType / dimBoost / tags）。
 *
 * 强约束：**确定性中文关键词词典，不调用 LLM**。
 * 同样的输入必然得到同样的输出，保证 QA 可写稳定单测、且离线可用。
 *
 * 纯函数、无副作用。
 */
import type { JobType, RadarDim } from '@/types/evaluation';
import type { TaskProfile } from '@/types/marketplace';

/** 维度强调规则：命中任一关键词 → 对应维度按 boost 系数强调 */
export interface DimBoostRule {
  /** 规则 id（单测断言用） */
  id: string;
  /** 触发关键词（中文为主，含少量英文别名） */
  keywords: string[];
  /** 维度强调系数（>1 = 更看重） */
  boost: Partial<Record<RadarDim, number>>;
  /** 命中后写入 TaskProfile.tags 的标准标签（Jaccard 匹配用） */
  tag: string;
}

/**
 * 维度强调词典（设计 §6 Step 1 给定的六类，系数原样落地）。
 * 主理人可在验收时微调系数，不影响算法结构。
 */
export const DIM_BOOST_RULES: DimBoostRule[] = [
  {
    id: 'cost',
    keywords: ['快', '省', '便宜', '低成本', '省钱', '预算', '性价比', '划算'],
    boost: { cost: 1.5 },
    tag: '低成本',
  },
  {
    id: 'reliability',
    keywords: ['稳定', '靠谱', '不翻车', '生产级', '可靠', '严谨', '稳健'],
    boost: { reliability: 1.5 },
    tag: '稳定',
  },
  {
    id: 'creativity',
    keywords: ['创意', '好看', '设计', '审美', '有想法', '风格', '灵感'],
    boost: { creativity: 1.4, quality: 1.2 },
    tag: '创意',
  },
  {
    id: 'comm',
    keywords: ['沟通', '解释', '文档', '汇报', '说明', '协作', '对接'],
    boost: { comm: 1.4 },
    tag: '沟通',
  },
  {
    id: 'quality',
    keywords: ['质量', '精致', '高质量', '细节', '专业', '精准'],
    boost: { quality: 1.4 },
    tag: '高质量',
  },
  {
    id: 'task',
    keywords: ['全能', '独立完成', '端到端', '一站式', '全栈', '自动化'],
    boost: { task: 1.3 },
    tag: '全能',
  },
];

/** 工种推断词典（设计 §6：图/文/码三类） */
export const JOB_KEYWORDS: Record<JobType, string[]> = {
  image: ['图', '画', '海报', 'ui', '插画', '视觉', '封面', '设计稿', '配图', '绘'],
  text: ['文', '稿', '翻译', '文案', '写作', '报告', '润色', '摘要', '公众号'],
  code: ['码', '脚本', '接口', 'bug', '开发', '重构', '后端', '前端', '爬虫', 'api', '部署'],
};

/** 工种判定顺序（命中数相同时的确定性 tie-break） */
const JOB_ORDER: JobType[] = ['image', 'text', 'code'];

/** 空任务画像（无需求输入时的中性值） */
export const EMPTY_TASK_PROFILE: TaskProfile = {
  jobType: null,
  dimBoost: {},
  tags: [],
};

/** 归一化文本：去空白、转小写（中文不受影响，英文别名可匹配） */
function normalizeText(text: string | null | undefined): string {
  return (text ?? '').toLowerCase();
}

/**
 * 统计某工种关键词在文本中的命中数。
 * 命中次数按「关键词种类数」计（同一关键词重复出现只计一次），避免刷词。
 */
function countJobHits(text: string, jobType: JobType): number {
  const keywords = JOB_KEYWORDS[jobType];
  let hits = 0;
  for (const kw of keywords) {
    if (text.includes(kw)) hits += 1;
  }
  return hits;
}

/**
 * 从文本推断工种；无任何命中返回 null（= 不限工种）。
 * 命中数相同时按 JOB_ORDER（image → text → code）取先者，保证确定性。
 */
export function inferJobType(text: string | null | undefined): JobType | null {
  const normalized = normalizeText(text);
  if (!normalized.trim()) return null;

  let best: JobType | null = null;
  let bestHits = 0;
  for (const job of JOB_ORDER) {
    const hits = countJobHits(normalized, job);
    if (hits > bestHits) {
      best = job;
      bestHits = hits;
    }
  }
  return bestHits > 0 ? best : null;
}

/**
 * 抽取维度强调系数。
 * 多条规则命中同一维度时**取最大值**（而非连乘），避免堆词导致权重爆炸，
 * 同时保证结果与规则书写顺序无关（确定性）。
 */
export function extractDimBoost(
  text: string | null | undefined,
): Partial<Record<RadarDim, number>> {
  const normalized = normalizeText(text);
  const boost: Partial<Record<RadarDim, number>> = {};
  if (!normalized.trim()) return boost;

  for (const rule of DIM_BOOST_RULES) {
    const hit = rule.keywords.some((kw) => normalized.includes(kw));
    if (!hit) continue;
    for (const [dim, factor] of Object.entries(rule.boost) as Array<[RadarDim, number]>) {
      const prev = boost[dim] ?? 1;
      boost[dim] = Math.max(prev, factor);
    }
  }
  return boost;
}

/** 工种 → 中文标签（tags 与 UI 共用） */
export const JOB_TAG_LABELS: Record<JobType, string> = {
  image: '制图',
  text: '文案',
  code: '代码',
};

/** 抽取命中的标准标签（去重、按词典顺序，供 Jaccard 匹配） */
export function extractTags(text: string | null | undefined): string[] {
  const normalized = normalizeText(text);
  if (!normalized.trim()) return [];
  const tags: string[] = [];
  for (const rule of DIM_BOOST_RULES) {
    if (rule.keywords.some((kw) => normalized.includes(kw)) && !tags.includes(rule.tag)) {
      tags.push(rule.tag);
    }
  }
  // 工种本身也是一个可匹配标签
  const job = inferJobType(normalized);
  if (job) {
    const jobTag = JOB_TAG_LABELS[job];
    if (!tags.includes(jobTag)) tags.push(jobTag);
  }
  return tags;
}

/**
 * 需求文本 → 任务画像（主入口）。
 *
 * @param text        自然语言需求，如「要一个稳定又便宜的后端 agent」
 * @param jobTypeHint UI 上显式选择的工种（'all' 或 undefined 表示交给文本推断）
 */
export function extractTaskProfile(
  text: string | null | undefined,
  jobTypeHint?: JobType | 'all' | null,
): TaskProfile {
  const inferred = inferJobType(text);
  const jobType: JobType | null =
    jobTypeHint && jobTypeHint !== 'all' ? jobTypeHint : inferred;

  const dimBoost = extractDimBoost(text);
  const tags = extractTags(text);

  // 显式选择的工种也要进 tags（否则手动选工种对 tagMatch 无贡献）
  if (jobType) {
    const jobTag = JOB_TAG_LABELS[jobType];
    if (!tags.includes(jobTag)) tags.push(jobTag);
  }

  return { jobType, dimBoost, tags };
}

export default extractTaskProfile;
