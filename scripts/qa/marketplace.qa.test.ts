/**
 * scripts/qa/marketplace.qa.test.ts
 *
 * QA 验收套件（严过关 / Yan）—— 直接 import 真实 src/ 源码，
 * 用 esbuild 打包后由 Node 22 执行（不依赖 vite/浏览器）。
 * 针对「Agent 人才市场 Tab + 三段职场叙事」增量实现（PRD v0.2-marketplace）。
 *
 * 覆盖：
 *  1) MARKETPLACE_AGENTS —— 长度 11、覆盖 5 职能、每张 initial_review.radar 六维齐全且 0–5、同源
 *  2) marketFilter      —— initialReviewScore / deriveQuickVerdict / uniqueStyles /
 *                          filterMarketAgents(职能/风格/报价/关键词) / sortMarketAgents(降序)
 *  3) getMarketplace()  —— mock 模式返回 11 张（services/api.ts）
 *  4) store.pickFromMarket   —— 入池(去重) + marketMetaMap + activeTab='onboard'
 *  5) store.dispatchDeepEvaluation —— 就地刷新 kpiMap/roiMap + 群体 z-score 重算
 *  6) 初审/深度边界 —— onboard 走 quick_verdict(PASS/OBSERVE/REJECT)、govern 走 verdict(MVP/OBSERVE/FIRED)
 *
 * 运行（仓库根目录）：
 *   unset NODE_OPTIONS
 *   export PATH="<path-to-node-22-bin>:$PATH"   # 使用 Node 22；可用系统 node 或 nvm 指定版本
 *   ./node_modules/.bin/esbuild scripts/qa/marketplace.qa.test.ts --bundle --format=esm \
 *     --platform=node --outfile=scripts/qa/.marketplace.qa.bundle.mjs \
 *     --define:import.meta.env='{"VITE_MOCK":"true","VITE_API_BASE":""}'
 *   node scripts/qa/.marketplace.qa.bundle.mjs
 */
import {
  initialReviewScore,
  uniqueStyles,
  filterMarketAgents,
  sortMarketAgents,
  deriveQuickVerdict,
} from "../../src/utils/marketFilter";
import { MARKETPLACE_AGENTS } from "../../src/mock/marketplaceAgents";
import { apiClient } from "../../src/services/api";
import { useAppStore } from "../../src/store/useAppStore";
import type {
  MarketplaceAgent,
  MarketFilters,
  QuickVerdict,
  AgentFunction,
  InitialReview,
} from "../../src/types/marketplace";
import type { RadarScore, Verdict } from "../../src/types";

/* ===================== 微型断言框架（沿用 engine.qa.test.ts） ===================== */
let pass = 0;
let fail = 0;
const fails: string[] = [];
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    fail++;
    fails.push(name + (detail ? ` (${detail})` : ""));
    console.log("  FAIL  " + name + (detail ? `  -> ${detail}` : ""));
  }
}
function section(title: string): void {
  console.log("\n=== " + title + " ===");
}

/* ===================== 测试辅助 ===================== */
const RADAR_KEYS = ["task", "quality", "comm", "creativity", "reliability", "cost"] as const;
function mkRadar(v: number): RadarScore {
  return { task: v, quality: v, comm: v, creativity: v, reliability: v, cost: v };
}
function mkReview(r: RadarScore, q: QuickVerdict = "OBSERVE"): InitialReview {
  return { radar: r, tag_eval: [], quick_verdict: q, confidence: 0 };
}
const ALL_FILTERS: MarketFilters = {
  search: "",
  function: "all",
  style: "all",
  maxBudget: null,
  sort: "review",
};

/* ===================== 1. MARKETPLACE_AGENTS 数据契约 ===================== */
section("MARKETPLACE_AGENTS · 数据契约（架构 §8 / PRD §5）");
check("MARKETPLACE_AGENTS 长度 = 11", MARKETPLACE_AGENTS.length === 11, `len=${MARKETPLACE_AGENTS.length}`);

const funcs = new Set(MARKETPLACE_AGENTS.map((a) => a.agent_function));
check("覆盖职能数 = 5", funcs.size === 5, Array.from(funcs).join(","));
for (const f of ["制图", "短视频", "文案", "前端", "后端"] as AgentFunction[]) {
  check(`含职能「${f}」`, funcs.has(f));
}
const countByFn: Record<string, number> = {};
for (const a of MARKETPLACE_AGENTS) countByFn[a.agent_function] = (countByFn[a.agent_function] || 0) + 1;
check("制图 3 张", countByFn["制图"] === 3, `got ${countByFn["制图"]}`);
check("短视频 3 张", countByFn["短视频"] === 3, `got ${countByFn["短视频"]}`);
check("文案 3 张", countByFn["文案"] === 3, `got ${countByFn["文案"]}`);
check("前端 1 张", countByFn["前端"] === 1, `got ${countByFn["前端"]}`);
check("后端 1 张", countByFn["后端"] === 1, `got ${countByFn["后端"]}`);

// 逐张结构校验：profile / style_tags / source / work_thumbnails / initial_review / 六维 0–5 / 同源
let structOk = true;
let structDetail = "";
for (const a of MARKETPLACE_AGENTS) {
  if (!a.profile || !a.profile.id || !a.profile.name) { structOk = false; structDetail = `${a.profile?.id ?? "?"} 缺 profile/name`; break; }
  if (typeof a.profile.declared_budget !== "number") { structOk = false; structDetail = `${a.profile.id} declared_budget 非数`; break; }
  if (!Array.isArray(a.style_tags) || a.style_tags.length === 0) { structOk = false; structDetail = `${a.profile.id} style_tags 空`; break; }
  if (a.source !== "market_mock") { structOk = false; structDetail = `${a.profile.id} source=${a.source}`; break; }
  if (!Array.isArray(a.work_thumbnails) || a.work_thumbnails.length < 1) { structOk = false; structDetail = `${a.profile.id} work_thumbnails 空`; break; }
  if (!a.initial_review) { structOk = false; structDetail = `${a.profile.id} 缺 initial_review`; break; }
  const r = a.initial_review.radar as Record<string, number>;
  for (const k of RADAR_KEYS) {
    const v = r[k];
    if (typeof v !== "number" || v < 0 || v > 5) { structOk = false; structDetail = `${a.profile.id} radar.${k}=${v}`; break; }
  }
  if (!structOk) break;
  if (a.initial_review.radar !== a.profile.evaluation.radar) { structOk = false; structDetail = `${a.profile.id} initial_review.radar 与 evaluation.radar 不同源`; break; }
}
check("每张 agent 结构齐全（profile/style/source/缩略/initial_review/六维0–5/同源）", structOk, structDetail);

/* ===================== 2. initialReviewScore / deriveQuickVerdict ===================== */
section("marketFilter · initialReviewScore / deriveQuickVerdict（纯函数）");

check("initialReviewScore(undefined) = 0", initialReviewScore(undefined) === 0);
check("initialReviewScore(全5) = 5", initialReviewScore(mkReview(mkRadar(5))) === 5);
check("initialReviewScore(全4) = 4", approx(initialReviewScore(mkReview(mkRadar(4))), 4));
check(
  "initialReviewScore(mk-art-01) = 4.25",
  approx(initialReviewScore(MARKETPLACE_AGENTS[0].initial_review), 4.25),
  String(initialReviewScore(MARKETPLACE_AGENTS[0].initial_review)),
);

// deriveQuickVerdict 边界：均值 >=4 → PASS；>=3.3 → OBSERVE；否则 REJECT
check("deriveQuickVerdict(均4) → PASS", deriveQuickVerdict(mkRadar(4)) === "PASS");
check("deriveQuickVerdict(均5) → PASS", deriveQuickVerdict(mkRadar(5)) === "PASS");
check("deriveQuickVerdict(均3.3) → OBSERVE", deriveQuickVerdict(mkRadar(3.3)) === "OBSERVE");
check("deriveQuickVerdict(均3.29) → REJECT", deriveQuickVerdict(mkRadar(3.29)) === "REJECT");
check("deriveQuickVerdict(均0) → REJECT", deriveQuickVerdict(mkRadar(0)) === "REJECT");

// 数据合理性（非严格相等）：架构明确——market 样例的 quick_verdict 为「策展值」，
// deriveQuickVerdict 仅作「非市场候选的兜底派生」（架构 §3.1 / §8），二者允许边界附近偏差。
// 故仅校验「不严重矛盾」：PASS 不应低于 OBSERVE 阈值(3.3)；OBSERVE 不应低于 3.0；
// REJECT 不应达到 PASS 阈值(4.0)。可捕获真正的数据错误（如均值 2 却标 PASS）。
let qReasonable = true;
let qBad = "";
for (const a of MARKETPLACE_AGENTS) {
  const mean = initialReviewScore(a.initial_review);
  const q = a.initial_review!.quick_verdict;
  const ok =
    (q === "PASS" && mean >= 3.3) ||
    (q === "OBSERVE" && mean >= 3.0) ||
    (q === "REJECT" && mean < 4.0);
  if (!ok) {
    qReasonable = false;
    qBad = `${a.profile.id}: ${q} @ mean=${mean.toFixed(3)}`;
    break;
  }
}
check("每个 agent 的 quick_verdict 与雷达均值无严重矛盾（PASS≥3.3 / OBSERVE≥3.0 / REJECT<4.0）", qReasonable, qBad);

/* ===================== 3. uniqueStyles ===================== */
section("marketFilter · uniqueStyles（去重保序）");
const styles = uniqueStyles(MARKETPLACE_AGENTS);
check("uniqueStyles 无重复", new Set(styles).size === styles.length);
check("uniqueStyles 含「赛博朋克」", styles.includes("赛博朋克"));
check("uniqueStyles 含「React」", styles.includes("React"));
check("uniqueStyles 含「种草」", styles.includes("种草"));
check("uniqueStyles 返回 >0", styles.length > 0, `len=${styles.length}`);

/* ===================== 4. filterMarketAgents ===================== */
section("marketFilter · filterMarketAgents（职能/风格/报价/关键词）");
check("空筛选返回 11 张", filterMarketAgents(MARKETPLACE_AGENTS, ALL_FILTERS).length === 11);
check("按职能「制图」→ 3 张", filterMarketAgents(MARKETPLACE_AGENTS, { ...ALL_FILTERS, function: "制图" }).length === 3);
check("按职能「前端」→ 1 张", filterMarketAgents(MARKETPLACE_AGENTS, { ...ALL_FILTERS, function: "前端" }).length === 1);
check("按职能「后端」→ 1 张", filterMarketAgents(MARKETPLACE_AGENTS, { ...ALL_FILTERS, function: "后端" }).length === 1);
check("按风格「赛博朋克」→ 1 张", filterMarketAgents(MARKETPLACE_AGENTS, { ...ALL_FILTERS, style: "赛博朋克" }).length === 1);
check("按风格「种草」→ 2 张", filterMarketAgents(MARKETPLACE_AGENTS, { ...ALL_FILTERS, style: "种草" }).length === 2);
check("报价 ≤150 → 3 张", filterMarketAgents(MARKETPLACE_AGENTS, { ...ALL_FILTERS, maxBudget: 150 }).length === 3);
check("报价 ≤100 → 1 张", filterMarketAgents(MARKETPLACE_AGENTS, { ...ALL_FILTERS, maxBudget: 100 }).length === 1);
check("关键词「React」→ 1 张", filterMarketAgents(MARKETPLACE_AGENTS, { ...ALL_FILTERS, search: "React" }).length === 1);
check("关键词「海报」→ 1 张", filterMarketAgents(MARKETPLACE_AGENTS, { ...ALL_FILTERS, search: "海报" }).length === 1);
check("关键词「琳」→ 2 张", filterMarketAgents(MARKETPLACE_AGENTS, { ...ALL_FILTERS, search: "琳" }).length === 2);
check(
  "制图 + 报价≤200 → 2 张（国潮240被排除）",
  filterMarketAgents(MARKETPLACE_AGENTS, { ...ALL_FILTERS, function: "制图", maxBudget: 200 }).length === 2,
);

/* ===================== 5. sortMarketAgents ===================== */
section("marketFilter · sortMarketAgents（初审分/报价/性价比 降序）");
const byReview = sortMarketAgents(MARKETPLACE_AGENTS, "review");
const reviewScores = byReview.map((a) => initialReviewScore(a.initial_review));
let reviewDesc = true;
for (let i = 1; i < reviewScores.length; i++) {
  if (reviewScores[i] > reviewScores[i - 1] + 1e-9) { reviewDesc = false; break; }
}
check("review 排序：初审分严格降序", reviewDesc);
check("review 排序：首位 = mk-art-01（4.25 最高）", byReview[0].profile.id === "mk-art-01", byReview[0].profile.id);

const byBudget = sortMarketAgents(MARKETPLACE_AGENTS, "budget");
const budgets = byBudget.map((a) => a.profile.declared_budget);
let budgetAsc = true;
for (let i = 1; i < budgets.length; i++) {
  if (budgets[i] < budgets[i - 1]) { budgetAsc = false; break; }
}
check("budget 排序：报价升序", budgetAsc);
check("budget 排序：首位 = mk-copy-01（¥90 最低）", byBudget[0].profile.id === "mk-copy-01", byBudget[0].profile.id);

const byCost = sortMarketAgents(MARKETPLACE_AGENTS, "costperf");
const costScores = byCost.map(
  (a) => (initialReviewScore(a.initial_review) * 100) / Math.max(1, a.profile.declared_budget),
);
let costDesc = true;
for (let i = 1; i < costScores.length; i++) {
  if (costScores[i] > costScores[i - 1] + 1e-9) { costDesc = false; break; }
}
check("costperf 排序：性价比降序", costDesc);

/* ===================== 6. 初审/深度边界（quick_verdict vs verdict） ===================== */
section("初审/深度边界 · onboard 走 quick_verdict、govern 走 verdict");
const QUICK_SET = new Set<QuickVerdict>(["PASS", "OBSERVE", "REJECT"]);
const VERDICT_SET = new Set<Verdict>(["MVP", "OBSERVE", "FIRED"]);
let verdictOk = true;
let vDetail = "";
for (const a of MARKETPLACE_AGENTS) {
  const q = a.initial_review!.quick_verdict;
  const v = a.profile.evaluation.verdict;
  if (!QUICK_SET.has(q)) { verdictOk = false; vDetail = `${a.profile.id} quick_verdict=${q}`; break; }
  if (!VERDICT_SET.has(v)) { verdictOk = false; vDetail = `${a.profile.id} verdict=${v}`; break; }
  const expected: Verdict = q === "PASS" ? "MVP" : q === "OBSERVE" ? "OBSERVE" : "FIRED";
  if (v !== expected) { verdictOk = false; vDetail = `${a.profile.id} ${q}→${v}（期望 ${expected}）`; break; }
}
check(
  "onboard.quick_verdict ∈ {PASS,OBSERVE,REJECT} 且 govern.verdict ∈ {MVP,OBSERVE,FIRED} 且映射正确",
  verdictOk,
  vDetail,
);

/* ===================== 7. store · pickFromMarket ===================== */
section("store · pickFromMarket（挑选入池 + 去重 + 切 onboard）");
const store = useAppStore.getState();
store.setMarketAgents(MARKETPLACE_AGENTS);
check("store 默认 activeTab = 'market'", useAppStore.getState().activeTab === "market");
check("store 初始 candidates 为空", useAppStore.getState().candidates.length === 0);

useAppStore.getState().pickFromMarket("mk-art-01");
const s1 = useAppStore.getState();
check("pickFromMarket 后 candidates +1（含 mk-art-01）", s1.candidates.length === 1 && s1.candidates[0].id === "mk-art-01");
check("pickFromMarket 后 activeTab === 'onboard'", s1.activeTab === "onboard");
check("pickFromMarket 后 marketMetaMap 有 mk-art-01 记录", !!s1.marketMetaMap["mk-art-01"]);
check("pickFromMarket 后 selectedCandidateId === 'mk-art-01'", s1.selectedCandidateId === "mk-art-01");

useAppStore.getState().pickFromMarket("mk-art-01"); // 重复挑选同 id
check("重复挑选同 id 不重复入池（仍 1 条）", useAppStore.getState().candidates.length === 1);

useAppStore.getState().pickFromMarket("mk-vid-01"); // 第二个不同 agent
const s2 = useAppStore.getState();
check("挑选第二个不同 agent 后 candidates = 2", s2.candidates.length === 2);
check("挑选后 activeTab 仍为 'onboard'", s2.activeTab === "onboard");
check("marketMetaMap 含 mk-vid-01", !!s2.marketMetaMap["mk-vid-01"]);

/* ===================== 8. store · dispatchDeepEvaluation ===================== */
section("store · dispatchDeepEvaluation（派任务深度考核·就地刷 KPI/ROI）");
const profiles = ["mk-art-01", "mk-vid-01"].map(
  (id) => MARKETPLACE_AGENTS.find((a) => a.profile.id === id)!.profile,
);
useAppStore.getState().setCandidates(profiles);
useAppStore.getState().setActiveTab("govern");
check("dispatch 前 roiMap 为空", Object.keys(useAppStore.getState().roiMap).length === 0);

useAppStore.getState().dispatchDeepEvaluation("mk-art-01");
const d1 = useAppStore.getState();
check("dispatch 后 kpiMap[mk-art-01] 已生成（sample_n=20）", !!d1.kpiMap["mk-art-01"] && d1.kpiMap["mk-art-01"].sample_n === 20);
check(
  "dispatch 后 roiMap[mk-art-01] 已生成且 roi 为有限数",
  !!d1.roiMap["mk-art-01"] && Number.isFinite(d1.roiMap["mk-art-01"].roi),
  d1.roiMap["mk-art-01"] ? `roi=${d1.roiMap["mk-art-01"].roi}` : "undefined",
);
check("dispatch 后 roiMap[mk-art-01].roi_norm 已重算（有定义）", d1.roiMap["mk-art-01"].roi_norm !== undefined);
check(
  "dispatch 后 roiTrendMap[mk-art-01] 有趋势（12 窗口）",
  Array.isArray(d1.roiTrendMap["mk-art-01"]) && d1.roiTrendMap["mk-art-01"].length === 12,
);

useAppStore.getState().dispatchDeepEvaluation("mk-vid-01");
const d2 = useAppStore.getState();
check("dispatch 第二个后 roiMap 含 2 条", Object.keys(d2.roiMap).length === 2);
check(
  "两个 agent 的 roi_norm 都已定义",
  d2.roiMap["mk-art-01"].roi_norm !== undefined && d2.roiMap["mk-vid-01"].roi_norm !== undefined,
);
const sumNorm =
  (d2.roiMap["mk-art-01"].roi_norm ?? 0) + (d2.roiMap["mk-vid-01"].roi_norm ?? 0);
check("群体 z-score：两者 roi_norm 之和≈0（均值0标准化）", approx(sumNorm, 0), `sum=${sumNorm}`);

/* ===================== 9. services/api · getMarketplace（mock） ===================== */
// 放异步 IIFE：避免在 ESM 顶层用 await；其余同步用例已先执行。
(async () => {
  section("services/api · getMarketplace（mock 返回 11 张）");
  let list: MarketplaceAgent[] = [];
  try {
    list = await apiClient.getMarketplace();
  } catch (e) {
    check("getMarketplace() 调用未抛错", false, String(e));
  }
  check("getMarketplace() 返回 11 张", list.length === 11, `len=${list.length}`);
  check("getMarketplace() 返回即 MARKETPLACE_AGENTS（同源引用）", list === MARKETPLACE_AGENTS);

  /* ===================== 汇总 ===================== */
  console.log(`\n========== 市场增量 QA 汇总 ==========`);
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    console.log("失败项：\n - " + fails.join("\n - "));
  }
  // 用 exitCode 替代 process.exit，确保 stdout 在进程退出前被冲刷（避免管道截断）
  process.exitCode = fail > 0 ? 1 : 0;
})();
