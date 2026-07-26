/**
 * QA 前端逻辑核查（Node 内置 type-stripping，直接执行真实 TS 源）。
 * 校验：
 *   1) computeUserFit 公式（与后端镜像）：满分、超预算硬约束、审美减分、裁剪；
 *   2) mockEvaluator 事件序列：六维逐维点亮 → narration → audio → verdict → done，
 *      且 verdict.user_fit 与 computeUserFit 一致（Mock 与真实同 schema）。
 *
 * 运行（仓库根目录）：
 *   NODE_OPTIONS= node --experimental-strip-types scripts/qa/frontend.strip.test.ts
 */
import { computeUserFit, RADAR_DIMS, DEFAULT_PREFERENCE } from "./_fesrc/utils/radar.ts";
import { MOCK_FIXTURES } from "./_fesrc/mock/samples.ts";
import { mockEvaluator } from "./_fesrc/services/mockEvaluator.ts";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    fail++;
    fails.push(name);
    console.log("  FAIL  " + name);
  }
}

console.log("\n=== radar.ts · computeUserFit 公式（与后端镜像）===");
const perfect = computeUserFit({
  radar: { task: 5, quality: 5, comm: 5, creativity: 5, reliability: 5, cost: 5 },
  preference: DEFAULT_PREFERENCE,
  declared_budget: 100,
  declared_tags: ["React"],
  inferred_aesthetic: "neutral",
});
check("满分(含stack加分)裁剪到 100", perfect.fit === 100);
check("包含技术栈加分证据", perfect.evidence.some((e: string) => e.includes("技术栈")));

const over = computeUserFit({
  radar: { task: 5, quality: 5, comm: 5, creativity: 5, reliability: 5, cost: 5 },
  preference: { ...DEFAULT_PREFERENCE, budget_max: 50 },
  declared_budget: 200,
  declared_tags: [],
  inferred_aesthetic: "neutral",
});
check("超预算 fit < 100（硬约束生效）", over.fit < 100);
check("超预算含预算证据", over.evidence.some((e: string) => e.includes("预算")));

const aes = computeUserFit({
  radar: { task: 5, quality: 5, comm: 5, creativity: 5, reliability: 5, cost: 5 },
  preference: { ...DEFAULT_PREFERENCE, aesthetic: "minimal" },
  declared_budget: 100,
  declared_tags: [],
  inferred_aesthetic: "rich",
});
check("审美不符 fit < 100", aes.fit < 100);
check("审美不符含减分证据", aes.evidence.some((e: string) => e.includes("不符")));

const neg = computeUserFit({
  radar: { task: 0, quality: 0, comm: 0, creativity: 0, reliability: 0, cost: 0 },
  preference: { ...DEFAULT_PREFERENCE, aesthetic: "minimal" },
  declared_budget: 100,
  declared_tags: [],
  inferred_aesthetic: "rich",
});
check("下限裁剪 >= 0", neg.fit >= 0);

const c1 = computeUserFit({
  radar: MOCK_FIXTURES["candidate-01"].radar,
  preference: DEFAULT_PREFERENCE,
  declared_budget: 180,
  declared_tags: ["React", "UI"],
  inferred_aesthetic: MOCK_FIXTURES["candidate-01"].inferred_aesthetic,
});
check("candidate-01 user_fit == 90.5（与后端镜像）", Math.abs(c1.fit - 90.5) < 1e-9);

console.log("\n=== mockEvaluator · 事件序列（与真实 SSE schema 一致）===");
const events: any[] = [];
await mockEvaluator.evaluate(
  {
    candidate: {
      id: "candidate-01",
      name: "琳达",
      declared_tags: ["React", "UI"],
      declared_budget: 180,
    },
    preference: DEFAULT_PREFERENCE,
    options: {},
  } as any,
  (ev: any) => events.push(ev),
);

const types = events.map((e: any) => e.type);
check("首 6 个事件为 radar_update 逐维点亮", (() => {
  const firstSix = types.slice(0, 6);
  const dims = firstSix.map((_: any, i: number) =>
    events[i].type === "radar_update" ? events[i].dim : null,
  );
  return firstSix.every((t: any) => t === "radar_update") && dims.join(",") === RADAR_DIMS.join(",");
})());

check("包含 narration 事件", types.includes("narration"));
check("包含 audio 事件（语音补「说」）", types.includes("audio"));
check("narration 以 is_final=true 收尾", (() => {
  const narr = events.filter((e: any) => e.type === "narration");
  return narr.length > 0 && narr[narr.length - 1].is_final === true;
})());

const verdictEv = events.find((e: any) => e.type === "verdict");
check("含 verdict 事件", !!verdictEv);
check("verdict.verdict == MVP", verdictEv && verdictEv.verdict === "MVP");
check("verdict.user_fit 与 computeUserFit 一致", verdictEv && Math.abs(verdictEv.user_fit - c1.fit) < 1e-9);
check("verdict.user_fit 在 [0,100]", verdictEv && verdictEv.user_fit >= 0 && verdictEv.user_fit <= 100);
check("verdict.evidence_trace 为数组", verdictEv && Array.isArray(verdictEv.evidence_trace));

const doneEv = events.find((e: any) => e.type === "done");
check("以 done 事件结束且含 evaluation_id", !!doneEv && !!doneEv.evaluation_id);

const audioEv = events.find((e: any) => e.type === "audio");
check("audio.chunk 为有效 base64 文本", audioEv && (() => {
  try {
    return Buffer.from(audioEv.chunk, "base64").toString("utf-8").length > 0;
  } catch {
    return false;
  }
})());

console.log(`\n前端逻辑核查：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log("失败项：" + fails.join("; "));
process.exit(fail > 0 ? 1 : 0);
