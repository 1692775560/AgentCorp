/**
 * scripts/qa/github-import.qa.test.ts
 *
 * QA 验收套件（严过关 / Yan）—— 直接 import 真实 src/ 源码，
 * 用 esbuild 打包后由 Node 22 执行（不依赖 vite/浏览器）。
 * 针对「GitHub 一键导入真实 Agent」增量实现（PRD v0.3-github-import / 架构 v0.3）。
 *
 * 覆盖范围（对应架构 T-G1 / T-G2 / PRD P0-2~P0-7）：
 *  1) parseRepoUrl      —— 兼容 https/http/裸域名/尾斜杠/.git/?query；非法→null
 *  2) inferFunction     —— 白名单命中 + 关键词兜底（video→短视频 / poster→制图）+ 默认全栈
 *  3) heuristicReview   —— 六维分桶 clamp[1,5]；末步复用 deriveQuickVerdict（不另写阈值，强约束）
 *  4) mapRepoToAgent    —— profile.evaluation.radar 与 initial_review.radar 同引用；source='github_import'；
 *                          notional_budget∈[80,320]（封顶 320）；verdict 镜像 quick_verdict；github_meta 挂载
 *  5) addImportedAgent  —— 同 id 去重、不同 id 追加、marketMetaMap 反查、github_meta 透传
 *  6) fetch 错误分流     —— 404→NEED_TOKEN；403+X-RateLimit-Remaining=0→RATE_LIMIT（Node fetch mock）
 *
 * 运行（仓库根目录）：
 *   unset NODE_OPTIONS
 *   export PATH="<path-to-node-22-bin>:$PATH"   # 使用 Node 22；可用系统 node 或 nvm 指定版本
 *   ./node_modules/.bin/esbuild scripts/qa/github-import.qa.test.ts --bundle --format=esm \
 *     --platform=node --outfile=scripts/qa/.github-import.qa.bundle.mjs \
 *     --define:import.meta.env='{"VITE_MOCK":"true","VITE_API_BASE":""}'
 *   node scripts/qa/.github-import.qa.bundle.mjs
 */
import {
  parseRepoUrl,
  inferFunction,
  heuristicReview,
  mapRepoToAgent,
  fetchRepo,
  GithubImportError,
  formatStars,
} from "../../src/services/githubImport";
import { deriveQuickVerdict } from "../../src/utils/marketFilter";
import { useAppStore } from "../../src/store/useAppStore";
import type {
  GithubRepoRaw,
  ReadmeResult,
  ContentsResult,
  GithubRelease,
} from "../../src/services/githubImport";
import type { MarketplaceAgent } from "../../src/types/marketplace";
import type { RadarScore } from "../../src/types";

/* ===================== 微型断言框架（沿用 marketplace.qa.test.ts） ===================== */
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

/* ===================== 测试辅助构造器 ===================== */
function mkRepo(over: Partial<GithubRepoRaw>): GithubRepoRaw {
  return {
    name: "repo",
    description: null,
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    pushed_at: null,
    owner: { login: "owner" },
    ...over,
  } as GithubRepoRaw;
}
function mkReadme(text: string): ReadmeResult {
  return {
    text,
    len: text.length,
    hasBadges: /\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/.test(text),
    hasHeadings: /^#{1,6}\s/m.test(text),
  };
}
function mkContents(over: Partial<ContentsResult> = {}): ContentsResult {
  return { hasExamples: false, hasVideo: false, hasDocs: false, thumbnails: [] as ContentsResult["thumbnails"], ...over };
}
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

const RADAR_KEYS = ["task", "quality", "comm", "creativity", "reliability", "cost"] as const;
function radarInRange(r: RadarScore): boolean {
  for (const k of RADAR_KEYS) {
    const v = r[k];
    if (typeof v !== "number" || v < 1 || v > 5) return false;
    // 至多 1 位小数（clamp1to5 的 Math.round(v*10)/10）
    if (Math.abs(v - Math.round(v * 10) / 10) > 1e-9) return false;
  }
  return true;
}

/* ===================== 1. parseRepoUrl ===================== */
section("parseRepoUrl · 兼容各种 URL 形态（PRD P0-2 / 架构 §7）");
{
  const cases: Array<[string, { owner: string; repo: string } | null]> = [
    ["https://github.com/foo/bar", { owner: "foo", repo: "bar" }],
    ["github.com/foo/bar/", { owner: "foo", repo: "bar" }], // 尾斜杠
    ["https://github.com/foo/bar.git", { owner: "foo", repo: "bar" }], // .git 后缀
    ["https://github.com/foo/bar?foo=bar", { owner: "foo", repo: "bar" }], // query
    ["http://github.com/foo/bar#section", { owner: "foo", repo: "bar" }], // http + hash
    ["github.com/foo/bar", { owner: "foo", repo: "bar" }], // 裸域名
    ["www.github.com/foo/bar", { owner: "foo", repo: "bar" }], // www 前缀
  ];
  for (const [input, expected] of cases) {
    const got = parseRepoUrl(input);
    const ok = expected
      ? !!got && got.owner === expected.owner && got.repo === expected.repo
      : got === null;
    check(`parseRepoUrl("${input}") → ${JSON.stringify(expected)}`, ok, JSON.stringify(got));
  }
  const illegals = [
    "",
    "   ",
    "github.com", // 无路径
    "github.com/", // 无 owner/repo
    "foo", // 乱码/单段
    "https://github.com/foo", // 仅 owner
    "not-a-url-at-all",
  ];
  for (const bad of illegals) {
    check(`parseRepoUrl("${bad}") → null（非法）`, parseRepoUrl(bad) === null);
  }
}

/* ===================== 2. inferFunction ===================== */
section("inferFunction · 白名单优先 + 关键词兜底（架构 §7.2 / PRD §4.2）");
{
  // 白名单命中
  const wl: Array<[string, string, string]> = [
    ["All-Hands-AI", "OpenHands", "后端"],
    ["abi", "screenshot-to-code", "前端"],
    ["geekan", "MetaGPT", "全栈"],
    ["assafelovic", "gpt-researcher", "文案"],
    ["11cafe", "jaaz", "制图"],
  ];
  for (const [owner, name, expect] of wl) {
    const repo = mkRepo({ owner: { login: owner }, name });
    check(`inferFunction(${owner}/${name}) → ${expect}`, inferFunction(repo) === expect);
  }
  // 关键词兜底
  const kw: Array<[string, string, string]> = [
    ["someone", "my-tool", "a video editing tool", "短视频"], // video
    ["someone", "poster-bot", "a poster generator", "制图"], // poster
  ];
  for (const [owner, name, desc, expect] of kw) {
    const repo = mkRepo({ owner: { login: owner }, name, description: desc });
    check(`inferFunction 关键词 "${desc}" → ${expect}`, inferFunction(repo) === expect);
  }
  // 默认全栈（不含任何关键词，且 description 不命中 agent/code 等后端词）
  const def = mkRepo({ owner: { login: "nobody" }, name: "hello-world", description: "a simple tool" });
  check("inferFunction 无匹配 → 全栈", inferFunction(def) === "全栈");
  // preset 覆盖优先
  const presetRepo = mkRepo({ owner: { login: "All-Hands-AI" }, name: "OpenHands" });
  check("inferFunction preset 覆盖白名单", inferFunction(presetRepo, undefined, "文案") === "文案");
}

/* ===================== 3. formatStars ===================== */
section("formatStars · ⭐ 数格式化");
check("formatStars(69200) → '69.2k'", formatStars(69200) === "69.2k");
check("formatStars(25000) → '25k'", formatStars(25000) === "25k");
check("formatStars(800) → '800'", formatStars(800) === "800");

/* ===================== 4. 构造三类评分场景 + heuristicReview ===================== */
section("heuristicReview · 六维分桶 + deriveQuickVerdict 衔接（架构 §7.1 / 强约束不另写阈值）");

// 高星 + MIT + 有 examples/视频/Release/近期活跃 → 六维高 → PASS
const passRepo = mkRepo({
  owner: { login: "SomeOrg", avatar_url: "" },
  name: "SuperAgent",
  description: "autonomous coding agent for developers",
  language: "python",
  stargazers_count: 70_000,
  forks_count: 500,
  pushed_at: daysAgo(5),
  topics: ["tool", "agent", "ai", "coding", "llm", "automation"],
  license: { spdx_id: "MIT" },
  default_branch: "main",
  html_url: "https://github.com/SomeOrg/SuperAgent",
});
const passReadme = mkReadme("# Title\n![badge](x)\n" + "x".repeat(9000));
const passContents = mkContents({ hasExamples: true, hasVideo: true, hasDocs: true, thumbnails: [] });
const passRelease: GithubRelease | null = { tag: "v1", name: "v1", body: "" };

// 中等星 + MIT + 近期 + 短 README 无素材 → OBSERVE 带
const obsRepo = mkRepo({
  owner: { login: "mid", avatar_url: "" },
  name: "mid-agent",
  description: "a helper library",
  language: "javascript",
  stargazers_count: 1_500,
  forks_count: 10,
  pushed_at: daysAgo(180),
  topics: ["lib"],
  license: { spdx_id: "MIT" },
  default_branch: "main",
  html_url: "https://github.com/mid/mid-agent",
});
const obsReadme = mkReadme("# Heading\nSome text here.");
const obsContents = mkContents();
const obsRelease: GithubRelease | null = null;

// 低星 + 非宽松协议(GPL) + 无素材 + 陈旧 → 六维低 → REJECT
const rejectRepo = mkRepo({
  owner: { login: "small", avatar_url: "" },
  name: "tiny-tool",
  description: "a tiny helper",
  language: "python",
  stargazers_count: 50,
  forks_count: 2,
  pushed_at: daysAgo(800),
  topics: [],
  license: { spdx_id: "GPL-3.0" },
  default_branch: "main",
  html_url: "https://github.com/small/tiny-tool",
});
const rejectReadme = mkReadme("short text");
const rejectContents = mkContents();
const rejectRelease: GithubRelease | null = null;

const passReview = heuristicReview(passRepo, passReadme, passContents, true);
const obsReview = heuristicReview(obsRepo, obsReadme, obsContents, false);
const rejectReview = heuristicReview(rejectRepo, rejectReadme, rejectContents, false);

check("PASS 场景：六维均在 [1,5] 且 1 位小数", radarInRange(passReview.radar));
check("PASS 场景：quick_verdict === 'PASS'", passReview.quick_verdict === "PASS", passReview.quick_verdict);
check(
  "PASS 场景：quick_verdict 与 deriveQuickVerdict(radar) 一致（复用既有阈值，未另写）",
  passReview.quick_verdict === deriveQuickVerdict(passReview.radar),
);

check("OBSERVE 场景：六维均在 [1,5]", radarInRange(obsReview.radar));
const obsMean =
  (obsReview.radar.task + obsReview.radar.quality + obsReview.radar.comm +
    obsReview.radar.creativity + obsReview.radar.reliability + obsReview.radar.cost) / 6;
check("OBSERVE 场景：均值 ≈3.5 落在 (3.3, 4) 带", obsMean > 3.3 && obsMean < 4, `mean=${obsMean.toFixed(3)}`);
check("OBSERVE 场景：quick_verdict === 'OBSERVE'", obsReview.quick_verdict === "OBSERVE", obsReview.quick_verdict);
check(
  "OBSERVE 场景：quick_verdict 与 deriveQuickVerdict(radar) 一致",
  obsReview.quick_verdict === deriveQuickVerdict(obsReview.radar),
);

check("REJECT 场景：六维均在 [1,5]", radarInRange(rejectReview.radar));
check("REJECT 场景：quick_verdict === 'REJECT'", rejectReview.quick_verdict === "REJECT", rejectReview.quick_verdict);
check(
  "REJECT 场景：quick_verdict 与 deriveQuickVerdict(radar) 一致",
  rejectReview.quick_verdict === deriveQuickVerdict(rejectReview.radar),
);

// 强约束不变量：所有场景都必须调用 deriveQuickVerdict（绝不另写阈值）
let usesDerive = true;
let usesDetail = "";
for (const [label, r] of [
  ["PASS", passReview],
  ["OBSERVE", obsReview],
  ["REJECT", rejectReview],
] as const) {
  if (r.quick_verdict !== deriveQuickVerdict(r.radar)) {
    usesDerive = false;
    usesDetail = `${label}: ${r.quick_verdict} vs ${deriveQuickVerdict(r.radar)}`;
    break;
  }
}
check("强约束：heuristicReview 末步严格复用 deriveQuickVerdict（三场景一致）", usesDerive, usesDetail);

/* ===================== 5. mapRepoToAgent ===================== */
section("mapRepoToAgent · 同构 MarketplaceAgent（架构 §3 / PRD P0-4、P0-5）");
{
  const passAgent = mapRepoToAgent(passRepo, passReadme, passContents, passRelease);
  const obsAgent = mapRepoToAgent(obsRepo, obsReadme, obsContents, obsRelease);
  const rejectAgent = mapRepoToAgent(rejectRepo, rejectReadme, rejectContents, rejectRelease);

  check("profile.evaluation.radar 与 initial_review.radar 同对象引用（PASS）",
    passAgent.profile.evaluation.radar === passAgent.initial_review!.radar);
  check("profile.evaluation.radar 与 initial_review.radar 同对象引用（OBSERVE）",
    obsAgent.profile.evaluation.radar === obsAgent.initial_review!.radar);
  check("profile.evaluation.radar 与 initial_review.radar 同对象引用（REJECT）",
    rejectAgent.profile.evaluation.radar === rejectAgent.initial_review!.radar);

  check("source === 'github_import'", passAgent.source === "github_import");
  check("agent_function（白名单/关键词）正确映射", passAgent.agent_function === "后端");

  // notional_budget 边界
  check("notional_budget ∈ [80,320]（PASS 场景 69200星 后端 ≈145）",
    passAgent.github_meta!.notional_budget >= 80 && passAgent.github_meta!.notional_budget <= 320,
    String(passAgent.github_meta!.notional_budget));

  const hiRepo = mkRepo({
    owner: { login: "big", avatar_url: "" }, name: "huge", description: "big agent",
    language: "python", stargazers_count: 1_000_000, forks_count: 0, pushed_at: daysAgo(10),
    topics: [], license: { spdx_id: "MIT" }, default_branch: "main", html_url: "https://github.com/big/huge",
  });
  const hiAgent = mapRepoToAgent(hiRepo, mkReadme("hi"), mkContents(), null);
  check("notional_budget 封顶 320（百万星 后端）", hiAgent.github_meta!.notional_budget === 320,
    String(hiAgent.github_meta!.notional_budget));

  const loRepo = mkRepo({
    owner: { login: "zzz", avatar_url: "" }, name: "low", description: "low tool",
    language: null, stargazers_count: 0, forks_count: 0, pushed_at: daysAgo(10),
    topics: [], license: { spdx_id: "MIT" }, default_branch: "main", html_url: "https://github.com/zzz/low",
  });
  const loAgent = mapRepoToAgent(loRepo, mkReadme("hi"), mkContents(), null);
  check("notional_budget 下限 ≥80（0 星 全栈 =100）", loAgent.github_meta!.notional_budget >= 80,
    String(loAgent.github_meta!.notional_budget));

  // verdict 镜像 quick_verdict
  check("verdict 镜像 quick_verdict：PASS → MVP", passAgent.profile.evaluation.verdict === "MVP");
  check("verdict 镜像 quick_verdict：OBSERVE → OBSERVE", obsAgent.profile.evaluation.verdict === "OBSERVE");
  check("verdict 镜像 quick_verdict：REJECT → FIRED", rejectAgent.profile.evaluation.verdict === "FIRED");

  // github_meta 正确挂载
  check("github_meta 挂载 owner/repo/stars/html_url",
    passAgent.github_meta!.owner === "SomeOrg" &&
    passAgent.github_meta!.repo === "SuperAgent" &&
    passAgent.github_meta!.stars === 70_000 &&
    passAgent.github_meta!.html_url === "https://github.com/SomeOrg/SuperAgent");
  check("非宽松协议 commercial_review=true（GPL 场景）", rejectAgent.github_meta!.commercial_review === true);
  check("宽松协议 commercial_review=false（MIT 场景）", passAgent.github_meta!.commercial_review === false);
}

/* ===================== 6. store · addImportedAgent ===================== */
section("store · addImportedAgent（合并+去重+metaMap，架构 §7.5 / PRD P1-2）");
{
  useAppStore.getState().setMarketAgents([]);
  const a1 = mapRepoToAgent(passRepo, passReadme, passContents, passRelease); // gh-SomeOrg-SuperAgent
  const a2 = mapRepoToAgent(obsRepo, obsReadme, obsContents, obsRelease); // gh-mid-mid-agent
  check("a1 与 a2 来源均为 github_import", a1.source === "github_import" && a2.source === "github_import");
  check("a1/a2 为不同 id（便于去重测试）", a1.profile.id !== a2.profile.id,
    `${a1.profile.id} vs ${a2.profile.id}`);

  useAppStore.getState().addImportedAgent(a1);
  let s = useAppStore.getState();
  check("addImportedAgent 后 marketAgents = 1", s.marketAgents.length === 1, `len=${s.marketAgents.length}`);
  check("marketMetaMap 含 a1", !!s.marketMetaMap[a1.profile.id]);

  useAppStore.getState().addImportedAgent(a1); // 重复同 id
  s = useAppStore.getState();
  check("重复同 id 不重复（仍 1 条）", s.marketAgents.length === 1, `len=${s.marketAgents.length}`);
  check("重复同 id 后仍为同一对象引用（覆盖而非新增）", s.marketAgents[0] === a1);

  useAppStore.getState().addImportedAgent(a2); // 不同 id
  s = useAppStore.getState();
  check("不同 id 追加后 marketAgents = 2", s.marketAgents.length === 2, `len=${s.marketAgents.length}`);
  check("marketMetaMap 含 a2", !!s.marketMetaMap[a2.profile.id]);
  check("a1.github_meta 在合并后仍透传", s.marketAgents[0].github_meta?.stars === 70_000);
}

/* ===================== 7. fetch 错误分流（Node 内置 fetch mock） ===================== */
(async () => {
  section("fetch* · 错误分流（404→NEED_TOKEN / 403+RATE=0→RATE_LIMIT，架构 §7.4）");
  const origFetch = globalThis.fetch;
  try {
    // 404 → NEED_TOKEN（仓库不存在 / 私库无 token，GitHub 不泄露存在性）
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    try {
      await fetchRepo("a", "b");
      check("fetchRepo 404 → 抛错（NEED_TOKEN）", false, "未抛错");
    } catch (e) {
      check(
        "fetchRepo 404 → GithubImportError(NEED_TOKEN)",
        e instanceof GithubImportError && (e as GithubImportError).code === "NEED_TOKEN",
        String((e as Error).message),
      );
    }

    // 403 + X-RateLimit-Remaining=0 → RATE_LIMIT
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 403,
        headers: { "X-RateLimit-Remaining": "0" },
      })) as unknown as typeof fetch;
    try {
      await fetchRepo("a", "b");
      check("fetchRepo 403+RATE=0 → 抛错（RATE_LIMIT）", false, "未抛错");
    } catch (e) {
      check(
        "fetchRepo 403+X-RateLimit-Remaining=0 → GithubImportError(RATE_LIMIT)",
        e instanceof GithubImportError && (e as GithubImportError).code === "RATE_LIMIT",
        String((e as Error).message),
      );
    }

    // 其它非 2xx（如 500）→ UNKNOWN（透传 status）
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    try {
      await fetchRepo("a", "b");
      check("fetchRepo 500 → 抛错（UNKNOWN）", false, "未抛错");
    } catch (e) {
      check(
        "fetchRepo 500 → GithubImportError(UNKNOWN)",
        e instanceof GithubImportError && (e as GithubImportError).code === "UNKNOWN",
        String((e as Error).message),
      );
    }
  } finally {
    globalThis.fetch = origFetch;
  }

  /* ===================== 汇总 ===================== */
  console.log(`\n========== GitHub 导入增量 QA 汇总 ==========`);
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    console.log("失败项：\n - " + fails.join("\n - "));
  }
  // 用 exitCode 替代 process.exit，确保 stdout 在进程退出前被冲刷（避免管道截断）
  process.exitCode = fail > 0 ? 1 : 0;
})();
