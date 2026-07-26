import { MOCK_CANDIDATES } from "../src/mock/samples";
import { buildGovernProfiles } from "../src/mock/telemetrySynth";

function run() {
  const p = buildGovernProfiles(MOCK_CANDIDATES);
  return p;
}

const a = run();
const b = run();

// 确定性校验
const sameKpi =
  JSON.stringify(a.kpiMap) === JSON.stringify(b.kpiMap);
const sameRoi = JSON.stringify(a.roiMap) === JSON.stringify(b.roiMap);
const sameBoard =
  JSON.stringify(a.leaderboard) === JSON.stringify(b.leaderboard);

console.log("=== 确定性（两次跑一致）===");
console.log("kpi:", sameKpi, "roi:", sameRoi, "leaderboard:", sameBoard);

console.log("\n=== 擂台排名 ===");
for (const e of a.leaderboard) {
  const roi = a.roiMap[e.agentId];
  console.log(
    `#${e.rank} ${e.name} | tier=${e.tier} | state=${e.state} | fit=${e.user_fit} | roi=${roi.roi.toFixed(2)} | roi_norm=${e.roi_norm.toFixed(2)} | cost fusion score=${roi.cost_perf_score.toFixed(2)}`,
  );
}

console.log("\n=== 选中候选-02 KPI ===");
const k = a.kpiMap["candidate-02"];
console.log(
  `TCR=${(k.task_completion_rate * 100).toFixed(0)}% FSR=${(k.first_success_rate * 100).toFixed(0)}% RR=${(k.rework_rate * 100).toFixed(0)}% ADL=${Math.round(k.avg_delivery_latency_ms)}ms AR=${(k.autonomy_rate * 100).toFixed(0)}% ER=${(k.escalation_rate * 100).toFixed(0)}% CGR=${(k.cross_task_generalization * 100).toFixed(0)}% SCR=${(k.stability_consistency * 100).toFixed(0)}%`,
);

const ok = sameKpi && sameRoi && sameBoard;
console.log("\nRESULT:", ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
