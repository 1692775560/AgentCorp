/**
 * scripts/qa/engine.qa.test.ts
 *
 * 引擎层独立验证套件 —— 直接引入 src/ 真实源码，
 * 用 esbuild 打包后由 Node 22 执行（不依赖 vite/浏览器）。
 *
 * 覆盖：
 *  1) metricsEngine —— 8 项 KPI 聚合（TCR/FSR/RR/ADL/AR/ER/CGR/SCR）
 *  2) roiEngine      —— 成本五要素 + 价值两要素 → ROI/IPR/SRPC/CPS 公式、
 *                       cost_perf 融合（λ 加权客观 CPS + 主观雷达 cost）、
 *                       超预算 cost 权重归零（经 radar.computeUserFit）、
 *                       群体 z-score 标准化
 *  3) strategyEngine —— 5 态转换表 + 守卫（月擂台末位→TRAINING / manual→RETIRED / 榜首 MVP）
 *  4) radar.ts       —— computeUserFit：costPerfScore 融合对旧调用零影响（可选参数）
 *  5) evaluationAdapter —— consume 增量转换（雷达逐维 / 宣判 / done / noop）
 *  6) 集成 —— useAppStore.runMonthlyArena / fireAgent（真实引擎数据 → UI 态）
 *  7) 确定性 —— buildGovernProfiles 两次跑结果完全一致
 *
 * 运行（仓库根目录）：
 *   node_modules/.bin/esbuild scripts/qa/engine.qa.test.ts --bundle --format=esm \
 *     --platform=node --outfile=scripts/qa/.engine.qa.bundle.mjs
 *   env -u NODE_OPTIONS <node22> scripts/qa/.engine.qa.bundle.mjs
 */
import {
  computeKpi,
  taskCompletionRate,
  firstSuccessRate,
  reworkRate,
  avgLatency,
  autonomyRate,
  escalationRate,
  crossGen,
  stability,
} from "../../src/engine/metricsEngine";
import {
  computeRoi,
  normCps,
  zscore,
  DEFAULT_LAMBDA,
  DEFAULT_ROI_BASELINE,
} from "../../src/engine/roiEngine";
import {
  transition,
  LIFECYCLE_LABELS,
} from "../../src/engine/strategyEngine";
import { EvaluationAdapter } from "../../src/engine/evaluationAdapter";
import {
  computeUserFit,
  DEFAULT_PREFERENCE,
  RADAR_DIMS,
} from "../../src/utils/radar";
import { buildGovernProfiles } from "../../src/mock/telemetrySynth";
import { MOCK_CANDIDATES } from "../../src/mock/samples";
import { useAppStore } from "../../src/store/useAppStore";
import type {
  TelemetryEvent,
  RadarScore,
  LifecycleState,
  LifecycleTrigger,
  StrategyContext,
} from "../../src/types";

/* ===================== 微型断言框架 ===================== */
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

/* ===================== 测试数据构造 ===================== */
function ev(p: Partial<TelemetryEvent>): TelemetryEvent {
  return {
    agent_id: "a",
    task_id: "a-t",
    success: true,
    first_try: true,
    rework: 0,
    latency_ms: 1000,
    human_interventions: 0,
    escalations: 0,
    out_of_domain: false,
    ts: "2025-07-22T00:00:00Z",
    ...p,
  };
}
const EMPTY_RADAR: RadarScore = {
  task: 0,
  quality: 0,
  comm: 0,
  creativity: 0,
  reliability: 0,
  cost: 0,
};

/* ===================== 1. metricsEngine ===================== */
section("metricsEngine · 8 项 KPI 聚合");

// 4 条遥测：3 成功 1 失败；2 一次成功；1 返工(在成功中)；2 无人工介入；1 升级；2 跨域(1 解决)
const evs: TelemetryEvent[] = [
  ev({ success: true, first_try: true, rework: 0, latency_ms: 1000, human_interventions: 0, escalations: 0, out_of_domain: true }),
  ev({ success: true, first_try: false, rework: 1, latency_ms: 2000, human_interventions: 0, escalations: 0, out_of_domain: true }),
  ev({ success: true, first_try: true, rework: 0, latency_ms: 1500, human_interventions: 1, escalations: 0, out_of_domain: false }),
  ev({ success: false, first_try: false, rework: 0, latency_ms: 500, human_interventions: 1, escalations: 1, out_of_domain: false }),
];
check("TCR = 3/4 = 0.75", approx(taskCompletionRate(evs), 0.75));
check("FSR = 2/4 = 0.5", approx(firstSuccessRate(evs), 0.5));
// RR = 返工任务数(1) / 完成任务数(3) = 0.3333（失败不计入分母）
check("RR = 1/3 ≈ 0.3333（失败不计入分母）", approx(reworkRate(evs), 1 / 3));
check("ADL = mean(1000,2000,1500,500) = 1250", approx(avgLatency(evs), 1250));
// AR = 无人工介入的完成任务(2) / 完成任务(3) = 0.6667
check("AR = 2/3 ≈ 0.6667", approx(autonomyRate(evs), 2 / 3));
check("ER = 1/4 = 0.25", approx(escalationRate(evs), 0.25));
// CGR 独立用例：跨域 2 条，1 成功 1 失败 → 0.5（与 evs 解耦，避免污染其他 KPI 计数）
const oodEvs: TelemetryEvent[] = [
  ev({ out_of_domain: true, success: true }),
  ev({ out_of_domain: true, success: false }),
];
check("CGR = 1/2 = 0.5", approx(crossGen(oodEvs), 0.5));
// 空数组安全
check("TCR 空数组 = 0", taskCompletionRate([]) === 0);
check("RR 无完成 = 0", reworkRate([ev({ success: false })]) === 0);
check("CGR 无跨域 = 0", crossGen([ev({ out_of_domain: false })]) === 0);

// stability：<2 轮 → 1.0；完全一致 → 1.0；有漂移 → (0,1)
check("SCR <2 轮返回 1.0", stability([EMPTY_RADAR]) === 1.0);
check("SCR 完全一致 = 1.0", stability([EMPTY_RADAR, { ...EMPTY_RADAR }, { ...EMPTY_RADAR }]) === 1.0);
const driftR = stability([
  { task: 5, quality: 5, comm: 5, creativity: 5, reliability: 5, cost: 5 },
  { task: 3, quality: 3, comm: 3, creativity: 3, reliability: 3, cost: 3 },
]);
check("SCR 漂移 ∈ (0,1)", driftR > 0 && driftR < 1, `got ${driftR.toFixed(4)}`);

// computeKpi 聚合 + 字段透传
const k = computeKpi(evs, "2025-W30", [EMPTY_RADAR, EMPTY_RADAR], "2025-07-22T09:30:00Z");
check("computeKpi.task_completion_rate = 0.75", approx(k.task_completion_rate, 0.75));
check("computeKpi.sample_n = 4", k.sample_n === 4);
check("computeKpi.window 透传", k.window === "2025-W30");
check("computeKpi.computedAt 透传", k.computedAt === "2025-07-22T09:30:00Z");
check("computeKpi.stability_consistency = 1.0（两轮一致）", approx(k.stability_consistency, 1.0));
check("computeKpi.agentId 取首条", k.agentId === "a");

/* ===================== 2. roiEngine ===================== */
section("roiEngine · ROI/IPR/SRPC/CPS + 融合 + z-score");

const cost = { c_tok: 10, c_npu: 10, c_call: 5, c_hum: 5, c_ret: 0 };
const value = {
  weight: { core: 1 },
  success: { core: 1 },
  U_base: 10,
  rho: 1,
  n_retry: 0,
  n_success: 5,
  V_hum: 0,
};
// C_total=30, U_task=10, U_eff=10, V_total=10, roi=-20/30, ipr=10/30, srpc=5/30
const r1 = computeRoi(cost, value, DEFAULT_ROI_BASELINE);
check("ROI = (10-30)/30 = -0.6667", approx(r1.roi, -20 / 30));
check("IPR = 10/30 = 0.3333", approx(r1.ipr, 10 / 30));
check("SRPC = 5/30 = 0.1667", approx(r1.srpc, 5 / 30));
// 无融合时 cost_perf_score = cps = normCps(ipr)
check("CPS（无融合）= normCps(ipr)", approx(r1.cost_perf_score, normCps(r1.ipr)));
check("roi_index = roi / baseline", approx(r1.roi_index, r1.roi / DEFAULT_ROI_BASELINE));
check("roi_norm 未传群体时为 undefined", r1.roi_norm === undefined);

// normCps 边界
check("normCps(0)=0", normCps(0) === 0);
check("normCps(5)=5（封顶）", normCps(5) === 5);
check("normCps(10)=5（clamp 封顶）", normCps(10) === 5);
check("normCps(-1)=0（clamp 下限）", normCps(-1) === 0);

// 融合：radarCost=4, lambda=0.5
// costPerfNorm = 0.5*(cps/5) + 0.5*(4/5)
const r2 = computeRoi(cost, value, DEFAULT_ROI_BASELINE, { radarCost: 4, lambda: 0.5 });
const cps = normCps(r1.ipr); // = ipr = 0.3333
const expectedPerf = (0.5 * (cps / 5) + 0.5 * (4 / 5)) * 5;
check(
  "cost_perf 融合 = λ·(cps/5)+(1-λ)·(radarCost/5) 再 ×5",
  approx(r2.cost_perf_score, expectedPerf),
  `got ${r2.cost_perf_score.toFixed(4)} expect ${expectedPerf.toFixed(4)}`,
);
check("λ 默认 0.5", DEFAULT_LAMBDA === 0.5);

// 高价值正 ROI 场景
const costB = { c_tok: 2, c_npu: 2, c_call: 1, c_hum: 0, c_ret: 0 };
const valueB = {
  weight: { core: 1 },
  success: { core: 1 },
  U_base: 50,
  rho: 1,
  n_retry: 0,
  n_success: 4,
  V_hum: 20,
};
// C=5, U_task=50, V_total=70, roi=(70-5)/5=13
const r3 = computeRoi(costB, valueB, DEFAULT_ROI_BASELINE);
check("正 ROI 场景 roi = 13", approx(r3.roi, 13));
check("正 ROI 场景 ipr = 14", approx(r3.ipr, 14));

// C_total=0 防御：不出现 NaN/Infinity
const r0 = computeRoi({ c_tok: 0, c_npu: 0, c_call: 0, c_hum: 0, c_ret: 0 }, value, DEFAULT_ROI_BASELINE);
check("C_total=0 时 roi/ipr/srpc 不为 NaN", Number.isFinite(r0.roi) && Number.isFinite(r0.ipr) && Number.isFinite(r0.srpc));
check("C_total=0 时 roi=0", r0.roi === 0);

// z-score 群体标准化
check("zscore([]) = 0", zscore([], 1) === 0);
check("zscore(全相等) 不 NaN（σ 回退 1e-9）", Number.isFinite(zscore([5, 5, 5], 5)));
check("zscore([1,3], 1) = -1", approx(zscore([1, 3], 1), -1));
const pop = [1, 2, 3, 4];
const z = zscore(pop, -0.6667);
const mean = 2.5;
const std = Math.sqrt(1.25);
check("zscore 公式 = (x-μ)/σ", approx(z, (-0.6667 - mean) / std));

// 群体 z-score 端到端：阿强应为最低（负），琳达应为正
const gov = buildGovernProfiles(MOCK_CANDIDATES);
const roiNormLinda = gov.roiMap["candidate-01"].roi_norm!;
const roiNormQiang = gov.roiMap["candidate-03"].roi_norm!;
check("阿强 roi_norm < 0（群体垫底）", roiNormQiang < 0, `got ${roiNormQiang.toFixed(3)}`);
check("琳达 roi_norm > 0（群体领先）", roiNormLinda > 0, `got ${roiNormLinda.toFixed(3)}`);
check("琳达 roi_norm > 阿强 roi_norm", roiNormLinda > roiNormQiang);

/* ===================== 3. strategyEngine ===================== */
section("strategyEngine · 5 态转换表 + 守卫");

function t(state: LifecycleState, trigger: LifecycleTrigger, ctx: Partial<StrategyContext>) {
  return transition(state, trigger, {
    agentId: "a",
    rank: 1,
    totalCandidates: 3,
    roi_norm: 0,
    consecutiveBottom: 0,
    ...ctx,
  });
}

// ONBOARDING
check("ONBOARDING + probation_pass(eval≥3) → ACTIVE", t("ONBOARDING", "probation_pass", { evalScore: 4 }).to === "ACTIVE");
check("ONBOARDING + probation_fail(eval<3) → RETIRED", t("ONBOARDING", "probation_fail", { evalScore: 2 }).to === "RETIRED");

// ACTIVE
check("ACTIVE + monthly_arena(榜首) → ACTIVE(MVP)", t("ACTIVE", "monthly_arena", { rank: 1 }).to === "ACTIVE");
const bottom = t("ACTIVE", "monthly_arena", { rank: 3, totalCandidates: 3, consecutiveBottom: 0 });
check("ACTIVE + monthly_arena(末位,首次) → TRAINING(PIP)", bottom.to === "TRAINING");
check("末位迁移事件 reason 含『末位』", !!bottom.event && bottom.event.reason.includes("末位"));
check("末位迁移事件 trigger=monthly_arena", !!bottom.event && bottom.event.trigger === "monthly_arena");
// 末位但已连续 → 无合法迁移（保持 ACTIVE）
const consec = t("ACTIVE", "monthly_arena", { rank: 3, totalCandidates: 3, consecutiveBottom: 1 });
check("ACTIVE + monthly_arena(末位,已连续) → 无迁移保持 ACTIVE", consec.to === "ACTIVE" && consec.event === null);
check("ACTIVE + roi_drop(roi_norm<-1.5) → MAINTENANCE", t("ACTIVE", "roi_drop", { roi_norm: -2 }).to === "MAINTENANCE");
check("ACTIVE + manual → RETIRED", t("ACTIVE", "manual").to === "RETIRED");

// TRAINING
check("TRAINING + pip_pass(reEval≥3) → ACTIVE", t("TRAINING", "pip_pass", { reEvalScore: 3.5 }).to === "ACTIVE");
check("TRAINING + pip_fail → RETIRED", t("TRAINING", "pip_fail").to === "RETIRED");
check("TRAINING + monthly_arena(连续≥2) → RETIRED", t("TRAINING", "monthly_arena", { rank: 3, totalCandidates: 3, consecutiveBottom: 2 }).to === "RETIRED");
check("TRAINING + monthly_arena(连续<2) → 无迁移保持 TRAINING", t("TRAINING", "monthly_arena", { rank: 3, totalCandidates: 3, consecutiveBottom: 1 }).to === "TRAINING");

// MAINTENANCE
check("MAINTENANCE + replaced → ACTIVE", t("MAINTENANCE", "replaced").to === "ACTIVE");
check("MAINTENANCE + manual → RETIRED", t("MAINTENANCE", "manual").to === "RETIRED");

// RETIRED：无出边
check("RETIRED + 任意触发 → 保持 RETIRED 且 event=null", (() => {
  const r = t("RETIRED", "manual");
  return r.to === "RETIRED" && r.event === null;
})());

// 无合法规则 → 保持原态
check("ACTIVE + probation_pass（不合法触发）→ 保持 ACTIVE", t("ACTIVE", "probation_pass", { evalScore: 4 }).to === "ACTIVE");

// 五态标签齐全
check("LIFECYCLE_LABELS 含 5 态", Object.keys(LIFECYCLE_LABELS).length === 5);

/* ===================== 4. radar.ts · computeUserFit + cost_perf 融合 ===================== */
section("radar.ts · computeUserFit + costPerfScore 融合（R3/R5 防注水）");

const all5: RadarScore = { task: 5, quality: 5, comm: 5, creativity: 5, reliability: 5, cost: 5 };
const full = computeUserFit({
  radar: all5,
  preference: DEFAULT_PREFERENCE,
  declared_budget: 100,
  declared_tags: ["React"],
  inferred_aesthetic: "neutral",
});
check("满分 + React 加分裁剪到 100", full.fit === 100);

// 向后兼容：不传 costPerfScore 时与旧行为一致（用 radar.cost）
const noFusion = computeUserFit({
  radar: { ...all5, cost: 4 },
  preference: DEFAULT_PREFERENCE,
  declared_budget: 100,
  declared_tags: [],
  inferred_aesthetic: "neutral",
});
// 传 costPerfScore=4（应等于 radar.cost=4）→ 结果不变
const withFusionSame = computeUserFit({
  radar: { ...all5, cost: 4 },
  preference: DEFAULT_PREFERENCE,
  declared_budget: 100,
  declared_tags: [],
  inferred_aesthetic: "neutral",
  costPerfScore: 4,
});
check("costPerfScore=radar.cost 时结果与旧调用一致（零影响）", approx(withFusionSame.fit, noFusion.fit));

// 融合生效：costPerfScore=5 但 radar.cost=0 → 应高于未融合
const lowRadar = { ...all5, cost: 0 };
const fusedHigh = computeUserFit({
  radar: lowRadar,
  preference: DEFAULT_PREFERENCE,
  declared_budget: 100,
  declared_tags: [],
  inferred_aesthetic: "neutral",
  costPerfScore: 5,
});
const notFused = computeUserFit({
  radar: lowRadar,
  preference: DEFAULT_PREFERENCE,
  declared_budget: 100,
  declared_tags: [],
  inferred_aesthetic: "neutral",
});
check("costPerfScore 融合高于未融合（客观纠偏生效）", fusedHigh.fit > notFused.fit, `${fusedHigh.fit} vs ${notFused.fit}`);

// 超预算：cost 维度权重归零 → fit 不受 cost/costPerfScore 影响
const overA = computeUserFit({
  radar: { ...all5, cost: 0 },
  preference: { ...DEFAULT_PREFERENCE, budget_max: 50 },
  declared_budget: 200,
  declared_tags: [],
  inferred_aesthetic: "neutral",
  costPerfScore: 5,
});
const overB = computeUserFit({
  radar: { ...all5, cost: 5 },
  preference: { ...DEFAULT_PREFERENCE, budget_max: 50 },
  declared_budget: 200,
  declared_tags: [],
  inferred_aesthetic: "neutral",
  costPerfScore: 0,
});
check("超预算时 cost 权重归零：fit 与 cost/costPerfScore 无关", approx(overA.fit, overB.fit), `${overA.fit} vs ${overB.fit}`);
check("超预算 fit < 100（硬约束生效）", overA.fit < 100);

// 审美减分/加分
const aesNeg = computeUserFit({
  radar: all5,
  preference: { ...DEFAULT_PREFERENCE, aesthetic: "minimal" },
  declared_budget: 100,
  declared_tags: [],
  inferred_aesthetic: "rich",
});
check("审美不符 fit < 100", aesNeg.fit < 100);
const aesPos = computeUserFit({
  radar: all5,
  preference: { ...DEFAULT_PREFERENCE, aesthetic: "minimal" },
  declared_budget: 100,
  declared_tags: [],
  inferred_aesthetic: "minimal",
});
check("审美契合（含加分）仍为 100", aesPos.fit === 100);

// 下限裁剪
const neg = computeUserFit({
  radar: EMPTY_RADAR,
  preference: { ...DEFAULT_PREFERENCE, aesthetic: "minimal" },
  declared_budget: 100,
  declared_tags: [],
  inferred_aesthetic: "rich",
});
check("下限裁剪 >= 0", neg.fit >= 0);

// RADAR_DIMS 顺序固定（6 维）
check("RADAR_DIMS 含 6 维且顺序固定", RADAR_DIMS.join(",") === "task,quality,comm,creativity,reliability,cost");

/* ===================== 5. evaluationAdapter ===================== */
section("evaluationAdapter · consume 增量转换");
const adapter = new EvaluationAdapter();
const d1 = adapter.consume({ type: "radar_update", dim: "task", score: 4.5, confidence: 0.9, evidence: "x" });
check("consume radar_update 返回 {kind:'radar'}", d1.kind === "radar");
const snap1 = adapter.snapshot();
check("radar 逐维点亮生效", snap1.radar.task === 4.5);

const d2 = adapter.consume({ type: "verdict", verdict: "MVP", user_fit: 90, evidence_trace: [], confidence: 0.9 });
check("consume verdict(MVP) → state ACTIVE", d2.kind === "verdict" && adapter.snapshot().state === "ACTIVE");
const d3 = adapter.consume({ type: "verdict", verdict: "FIRED", user_fit: 10, evidence_trace: [], confidence: 0.9 });
check("consume verdict(FIRED) → state RETIRED", d3.kind === "verdict" && adapter.snapshot().state === "RETIRED");

const d4 = adapter.consume({ type: "done", evaluation_id: "e1" });
check("consume done → {kind:'done'}", d4.kind === "done");

const d5 = adapter.consume({ type: "narration", delta: "hi", is_final: false });
const d6 = adapter.consume({ type: "audio", chunk: "abc", format: "wav", sample_rate: 16000 });
check("consume narration → {kind:'noop'}（走语音通道）", d5.kind === "noop");
check("consume audio → {kind:'noop'}", d6.kind === "noop");

// ingestKpi / ingestRoi
adapter.ingestKpi(k);
adapter.ingestRoi(gov.roiMap["candidate-01"]);
const snap2 = adapter.snapshot();
check("ingestKpi 生效", snap2.kpi === k);
check("ingestRoi 生效", snap2.roi === gov.roiMap["candidate-01"]);

/* ===================== 6. 集成：store.runMonthlyArena / fireAgent ===================== */
section("集成 · useAppStore 编排（govern 切片 + 真实引擎数据）");
const store = useAppStore.getState();
store.setGovernData(gov);
const lb0 = useAppStore.getState().leaderboard;
check("擂台初始：琳达 rank1 MVP", lb0[0].agentId === "candidate-01" && lb0[0].tier === "MVP");
check("擂台初始：老张 rank2 NORMAL", lb0[1].agentId === "candidate-02" && lb0[1].tier === "NORMAL");
check("擂台初始：阿强 rank3 BOTTOM", lb0[2].agentId === "candidate-03" && lb0[2].tier === "BOTTOM");
check("初始全员 ACTIVE（绩效中心按 CandidateProfile.verdict=OBSERVE）", lb0.every((e) => e.state === "ACTIVE"));

// 月度擂台：阿强（末位 ACTIVE）→ TRAINING
useAppStore.getState().runMonthlyArena();
const stAfter = useAppStore.getState();
check("月度擂台后 阿强 → TRAINING", stAfter.lifecycleMap["candidate-03"] === "TRAINING");
check("月度擂台后 琳达 保持 ACTIVE(MVP)", stAfter.lifecycleMap["candidate-01"] === "ACTIVE");
const qiangHist = stAfter.lifecycleHistoryMap["candidate-03"];
check("阿强生命周期新增 monthly_arena 事件", qiangHist.some((e) => e.trigger === "monthly_arena" && e.to === "TRAINING"));

// 一键 fire：阿强 → RETIRED
useAppStore.getState().fireAgent("candidate-03");
const stFire = useAppStore.getState();
check("fireAgent 后 阿强 → RETIRED", stFire.lifecycleMap["candidate-03"] === "RETIRED");
const qiangEntry = stFire.leaderboard.find((e) => e.agentId === "candidate-03")!;
check("fireAgent 后 阿强 擂台 tier=BOTTOM(RETIRED)", qiangEntry.tier === "BOTTOM");
check("fireAgent 后 阿强 生命周期含 manual 事件", stFire.lifecycleHistoryMap["candidate-03"].some((e) => e.trigger === "manual" && e.to === "RETIRED"));

/* ===================== 7. 确定性 ===================== */
section("确定性 · buildGovernProfiles 两次跑一致");
const gA = buildGovernProfiles(MOCK_CANDIDATES);
const gB = buildGovernProfiles(MOCK_CANDIDATES);
check(
  "两次 KPI/ROI/擂台 JSON 完全一致",
  JSON.stringify(gA.kpiMap) === JSON.stringify(gB.kpiMap) &&
    JSON.stringify(gA.roiMap) === JSON.stringify(gB.roiMap) &&
    JSON.stringify(gA.leaderboard) === JSON.stringify(gB.leaderboard),
);

/* ===================== 汇总 ===================== */
console.log(`\n========== QA 汇总 ==========`);
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log("失败项：\n - " + fails.join("\n - "));
}
process.exit(fail > 0 ? 1 : 0);
