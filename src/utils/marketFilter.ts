/**
 * src/utils/marketFilter.ts
 * 市场筛选 / 排序纯函数（增量 · 架构 §2 文件列表）。
 *
 * 全部为无副作用纯函数，便于单测与复用（架构 T-M2 验收点：
 * 给定 11 条 → 筛选/排序结果确定）。
 */
import type { RadarScore } from "../types/evaluation";
import type {
  InitialReview,
  MarketFilters,
  MarketplaceAgent,
  QuickVerdict,
} from "../types/marketplace";

/** 六维均值（用于初审分展示与排序） */
export function initialReviewScore(r?: InitialReview): number {
  if (!r) return 0;
  const d = r.radar;
  return (d.task + d.quality + d.comm + d.creativity + d.reliability + d.cost) / 6;
}

/** 列出全部出现的风格 tag（去重、保序） */
export function uniqueStyles(agents: MarketplaceAgent[]): string[] {
  const set = new Set<string>();
  for (const a of agents) for (const t of a.style_tags) set.add(t);
  return Array.from(set);
}

/** 按关键词 / 职能 / 风格 / 报价上限过滤 */
export function filterMarketAgents(
  agents: MarketplaceAgent[],
  f: MarketFilters,
): MarketplaceAgent[] {
  const q = f.search.trim().toLowerCase();
  return agents.filter((a) => {
    if (f.function !== "all" && a.agent_function !== f.function) return false;
    if (f.style !== "all" && !a.style_tags.includes(f.style)) return false;
    if (f.maxBudget != null && a.profile.declared_budget > f.maxBudget) return false;
    if (q) {
      const hay = [
        a.profile.name,
        a.agent_function,
        ...a.style_tags,
        ...(a.initial_review?.tag_eval ?? []),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** 性价比分（初审分越高、报价越低 → 越优） */
function costPerfScore(a: MarketplaceAgent): number {
  const review = initialReviewScore(a.initial_review);
  return (review * 100) / Math.max(1, a.profile.declared_budget);
}

/** 排序：review=初审分 / budget=报价 / costperf=性价比（降序） */
export function sortMarketAgents(
  agents: MarketplaceAgent[],
  sort: MarketFilters["sort"],
): MarketplaceAgent[] {
  const arr = [...agents];
  const cmp =
    sort === "review"
      ? (a: MarketplaceAgent, b: MarketplaceAgent) =>
          initialReviewScore(b.initial_review) - initialReviewScore(a.initial_review)
      : sort === "budget"
        ? (a: MarketplaceAgent, b: MarketplaceAgent) =>
            a.profile.declared_budget - b.profile.declared_budget
        : (a: MarketplaceAgent, b: MarketplaceAgent) =>
            costPerfScore(b) - costPerfScore(a);
  arr.sort(cmp);
  return arr;
}

/**
 * 由六维雷达派生「快速初审」结论（入职评估 Tab 用 quick_verdict 文案）。
 * 真实模式可由 MiniCPM-o 直接产出；Mock 下作为样例/非市场候选的兜底派生。
 */
export function deriveQuickVerdict(radar: RadarScore): QuickVerdict {
  const mean =
    (radar.task +
      radar.quality +
      radar.comm +
      radar.creativity +
      radar.reliability +
      radar.cost) /
    6;
  if (mean >= 4) return "PASS";
  if (mean >= 3.3) return "OBSERVE";
  return "REJECT";
}
