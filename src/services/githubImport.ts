/**
 * src/services/githubImport.ts
 * GitHub 一键导入真实 Agent · 服务层（增量 T-G1 / 架构 §3 / PRD P0-3~P0-5）。
 *
 * 设计要点：
 * - 纯函数化：parseRepoUrl / inferFunction / heuristicReview / mapRepoToAgent 均为可单测纯函数
 *   （除 fetch* 网络调用），UI 与状态层只做编排（架构 §1.3）。
 * - 零依赖：原生 fetch 直连 api.github.com，无 octokit/axios；token 仅本地手动 Authorization 头。
 * - 启发式六维严格复用 `utils/marketFilter.ts` 的 `deriveQuickVerdict`（阈值 ≥4 PASS / ≥3.3 OBSERVE / <3.3 REJECT），
 *   绝不另写阈值（架构 D-G4 / 强约束）。
 * - `profile.evaluation.radar` 与 `initial_review.radar` **同一对象引用**（沿用 Mock 约定）。
 *
 * 失败路径（架构 §7.4）：
 * - 403 + X-RateLimit-Remaining===0 → RATE_LIMIT（限流，提示填 token）。
 * - 404（仓库不存在 / 私库无 token，GitHub 不泄露存在性）→ NEED_TOKEN（提示填 token 重试）。
 * - 其它非 2xx → UNKNOWN（透传 status）。
 */
import type {
  CandidateProfile,
  MediaRef,
  RadarScore,
  Evaluation,
  CodeRef,
  Verdict,
} from "../types/evaluation";
import type {
  AgentFunction,
  AgentSource,
  GithubImportMeta,
  InitialReview,
  MarketplaceAgent,
} from "../types/marketplace";
import { deriveQuickVerdict } from "../utils/marketFilter";

/* ============================================================
 * 原始数据形状（api.github.com 返回，精简）
 * ========================================================== */

/** GitHub 协议对象（license.spdx_id 用于成本/商用判定） */
export interface GithubLicense {
  spdx_id: string | null;
  name?: string;
}

/** GitHub 所有者对象 */
export interface GithubOwner {
  login: string;
  avatar_url?: string;
  html_url?: string;
}

/** /repos/{o}/{r} 抓取到的仓库原始数据 */
export interface GithubRepoRaw {
  full_name?: string;
  name: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  pushed_at: string | null;
  topics?: string[];
  archived?: boolean;
  default_branch?: string;
  license?: GithubLicense | null;
  owner: GithubOwner;
  html_url?: string;
}

/** README 解析结果 */
export interface ReadmeResult {
  text: string;
  len: number;
  hasBadges: boolean;
  hasHeadings: boolean;
}

/** 目录扫描结果（作品集素材） */
export interface ContentsResult {
  hasExamples: boolean; // examples/showcase/docs 下找到图片或视频
  hasVideo: boolean; // 找到演示视频
  hasDocs: boolean; // 找到 docs/ 目录（沟通分加成信号）
  thumbnails: MediaRef[]; // raw.githubusercontent 直链（图片/视频）
}

/** 最新 Release 摘要 */
export interface GithubRelease {
  tag: string;
  name: string;
  body: string;
}

/* ============================================================
 * 错误类型（供 UI 区分限流 / 私库 / 网络）
 * ========================================================== */

export type GithubImportErrorCode =
  | "RATE_LIMIT"
  | "NEED_TOKEN"
  | "NETWORK"
  | "UNKNOWN";

/** 统一错误：code 供 UI 分流提示与 token 重试 */
export class GithubImportError extends Error {
  code: GithubImportErrorCode;
  constructor(code: GithubImportErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "GithubImportError";
  }
}

/* ============================================================
 * 工具：URL 解析 / 数值分桶 / 格式化
 * ========================================================== */

const PERMISSIVE_LICENSE = [
  "MIT",
  "APACHE-2.0",
  "BSD",
  "BSD-2-CLAUSE",
  "BSD-3-CLAUSE",
  "ISC",
  "UNLICENSE",
];

/** 解析仓库地址，兼容 https / http / 裸 github.com / 尾斜杠 / .git / ?query / #hash / 裸 owner/repo */
export function parseRepoUrl(input: string): { owner: string; repo: string } | null {
  if (!input) return null;
  let s = input.trim();
  // 去掉协议
  s = s.replace(/^https?:\/\//i, "");
  // 去掉尾斜杠
  s = s.replace(/\/+$/, "");
  // 去掉 query / hash
  s = s.replace(/[?#].*$/, "");
  // 去掉 .git 后缀
  s = s.replace(/\.git$/i, "");
  // 去掉 github.com 前缀（含 www.）
  s = s.replace(/^(?:www\.)?github\.com\//i, "");
  // 现应为 owner/repo（可能带多余路径段）
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0].trim();
  const repo = parts[1].trim();
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** ⭐ 数格式化：69200 → "69.2k"，25000 → "25k"，800 → "800" */
export function formatStars(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    // 始终保留 1 位小数（69200 → "69.2k"，25000 → "25k"，1500 → "1.5k"）
    const rounded = Math.round(k * 10) / 10;
    return `${rounded}k`;
  }
  return String(n);
}

/** 把数值 clamp 到 [1,5] 并保留 1 位小数（架构 §7.1） */
function clamp1to5(v: number): number {
  const clamped = Math.min(5, Math.max(1, v));
  return Math.round(clamped * 10) / 10;
}

/** 距今天数 → 月数（用于可靠性分桶） */
function ageInMonths(iso: string | null): number {
  if (!iso) return 99;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 99;
  const days = (Date.now() - then) / 86_400_000;
  return days / 30;
}

/** 推导报价：clamp(round(stars/2000)+100, 80, 320)，后端/前端 +10（封顶 320） */
function clampBudget(stars: number, fn: AgentFunction): number {
  let b = Math.round(stars / 2000) + 100;
  if (fn === "后端" || fn === "前端") b += 10;
  return Math.min(320, Math.max(80, b));
}

/* ============================================================
 * fetch：直连 api.github.com（原生 fetch，无第三方 SDK）
 * ========================================================== */

/** 读取 GitHub API 响应头限流剩余 */
function rateLimitRemaining(res: Response): number {
  const v = res.headers.get("X-RateLimit-Remaining");
  return v == null ? Number.NaN : Number(v);
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 抓取仓库元数据（name/desc/language/license/star/fork/pushed_at/topics/owner） */
export async function fetchRepo(
  owner: string,
  repo: string,
  token?: string,
): Promise<GithubRepoRaw> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: authHeaders(token),
    });
  } catch (e) {
    throw new GithubImportError(
      "NETWORK",
      "无法连接 GitHub（网络异常或被 CORS 拦截）：" + (e as Error).message,
    );
  }

  const remaining = rateLimitRemaining(res);
  if (res.status === 403 && remaining === 0) {
    throw new GithubImportError(
      "RATE_LIMIT",
      "GitHub API 限速（剩余 0/60），请填入 Token（5000/h）后重试",
    );
  }
  if (res.status === 404) {
    // 仓库不存在 或 私库无 token（GitHub 返回 404 不泄露存在性）统一引导填 token
    throw new GithubImportError(
      "NEED_TOKEN",
      "仓库不存在或需权限：若为私有仓库请填入 Token 重试；公开库请核对地址",
    );
  }
  if (!res.ok) {
    throw new GithubImportError(
      "UNKNOWN",
      `GitHub 返回 ${res.status} ${res.statusText || ""}`.trim(),
    );
  }
  return (await res.json()) as GithubRepoRaw;
}

/** 抓取 README（Accept: raw 直接拿文本；失败返回空串） */
export async function fetchReadme(
  owner: string,
  repo: string,
  token?: string,
): Promise<ReadmeResult> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/readme`,
      {
        headers: { Accept: "application/vnd.github.raw+json", ...authHeaders(token) },
      },
    );
    if (!res.ok) {
      return { text: "", len: 0, hasBadges: false, hasHeadings: false };
    }
    const text = await res.text();
    return {
      text,
      len: text.length,
      hasBadges: /\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/.test(text),
      hasHeadings: /^#{1,6}\s/m.test(text),
    };
  } catch {
    return { text: "", len: 0, hasBadges: false, hasHeadings: false };
  }
}

/** 抓取最新 Release（/releases?per_page=1），失败或不存在返回 null */
export async function fetchReleases(
  owner: string,
  repo: string,
  token?: string,
): Promise<GithubRelease | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=1`,
      { headers: authHeaders(token) },
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{
      tag_name?: string;
      name?: string;
      body?: string;
    }>;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const r = arr[0];
    return {
      tag: r.tag_name ?? "",
      name: r.name ?? "",
      body: r.body ?? "",
    };
  } catch {
    return null;
  }
}

const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
const VIDEO_EXT = [".mp4", ".mov"];

/** raw.githubusercontent.com 直链构造（架构 §7.3） */
function rawUrl(owner: string, repo: string, branch: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

/** 由路径构造 MediaRef（图片/视频直链） */
function mediaFromPath(
  owner: string,
  repo: string,
  branch: string,
  path: string,
): MediaRef {
  const lower = path.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  const isVideo = VIDEO_EXT.includes("." + ext);
  return {
    type: isVideo ? `video/${ext}` : `image/${ext}`,
    url: rawUrl(owner, repo, branch, path),
  };
}

/** 扫描目录条目，抽取图片/视频素材 */
function scanItems(
  items: Array<{ name: string; path: string; type: string }>,
  owner: string,
  repo: string,
  branch: string,
): { thumbs: MediaRef[]; hasExamples: boolean; hasVideo: boolean } {
  const thumbs: MediaRef[] = [];
  let hasExamples = false;
  let hasVideo = false;
  for (const it of items) {
    if (it.type !== "file") continue;
    const lower = it.name.toLowerCase();
    const ext = lower.slice(lower.lastIndexOf("."));
    if (IMAGE_EXT.includes(ext)) {
      thumbs.push(mediaFromPath(owner, repo, branch, it.path));
      hasExamples = true;
    } else if (VIDEO_EXT.includes(ext)) {
      thumbs.push(mediaFromPath(owner, repo, branch, it.path));
      hasVideo = true;
      hasExamples = true;
    }
  }
  return { thumbs, hasExamples, hasVideo };
}

/** 列出子目录条目（供扫描 examples/showcase/docs） */
async function listDir(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token?: string,
): Promise<Array<{ name: string; path: string; type: string }>> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${
    path ? path + "/" : ""
  }?ref=${branch}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) return [];
  return (await res.json()) as Array<{ name: string; path: string; type: string }>;
}

/**
 * 抓取根目录并扫描 examples/showcase/docs 找图片/视频素材。
 * branch 失败自动回退 master（架构 §7.3）。
 */
export async function fetchContents(
  owner: string,
  repo: string,
  token?: string,
  branch: string = "main",
): Promise<ContentsResult> {
  const branches = Array.from(new Set([branch, "master"])).filter(Boolean);
  let rootItems: Array<{ name: string; path: string; type: string }> = [];
  let usedBranch = branch;
  for (const b of branches) {
    rootItems = await listDir(owner, repo, "", b, token);
    if (rootItems.length) {
      usedBranch = b;
      break;
    }
  }
  if (!rootItems.length) {
    return { hasExamples: false, hasVideo: false, hasDocs: false, thumbnails: [] };
  }

  const rootScan = scanItems(rootItems, owner, repo, usedBranch);
  let thumbs = [...rootScan.thumbs];
  let hasExamples = rootScan.hasExamples;
  let hasVideo = rootScan.hasVideo;
  let hasDocs = false;

  // 扫描 examples/showcase/docs 子目录
  for (const it of rootItems) {
    const lower = it.name.toLowerCase();
    if (it.type === "dir" && (lower === "examples" || lower === "showcase" || lower === "docs")) {
      if (lower === "docs") hasDocs = true;
      const sub = await listDir(owner, repo, it.path, usedBranch, token);
      const s = scanItems(sub, owner, repo, usedBranch);
      thumbs = [...thumbs, ...s.thumbs];
      if (s.hasExamples) hasExamples = true;
      if (s.hasVideo) hasVideo = true;
    }
  }

  return { hasExamples, hasVideo, hasDocs, thumbnails: thumbs };
}

/* ============================================================
 * 职能推断：白名单优先 + 关键词兜底（架构 §7.2 / PRD §4.2）
 * ========================================================== */

/** 人工预设白名单（owner/repo 精确匹配优先） */
const FUNCTION_WHITELIST: Record<string, AgentFunction> = {
  "all-hands-ai/openhands": "后端",
  "aider-ai/aider": "后端",
  "swe-agent/swe-agent": "后端",
  "abi/screenshot-to-code": "前端",
  "geekan/metagpt": "全栈",
  "mannaandpoem/openmanus": "全栈",
  "assafelovic/gpt-researcher": "文案",
  "crewaiinc/crewai": "全栈",
  "11cafe/jaaz": "制图",
  "paper2poster/paper2poster": "制图",
  "hkuds/videoagent": "短视频",
  "univa-agent/univa": "短视频",
  "rackyun/pixelle-video": "短视频",
  "significant-gravitas/autogpt": "全栈",
  "yoheinakajima/babyagi": "全栈",
  "camel-ai/owl": "全栈",
};

/**
 * 推断职能：preset 优先（预览卡手动改职能）；否则白名单精确匹配；最后关键词兜底。
 * 关键词兜底命中顺序：制图 → 短视频 → 文案 → 前端 → 后端 → 全栈 → 默认全栈。
 */
export function inferFunction(
  repo: GithubRepoRaw,
  readme?: ReadmeResult,
  preset?: AgentFunction,
): AgentFunction {
  if (preset) return preset;
  const key = `${repo.owner.login}/${repo.name}`.toLowerCase();
  if (FUNCTION_WHITELIST[key]) return FUNCTION_WHITELIST[key];

  const blob = [
    repo.name,
    repo.description ?? "",
    (repo.topics ?? []).join(" "),
    readme?.text ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (/poster|image|png|画|海报|design|figma|storyboard|海报/.test(blob)) return "制图";
  if (/video|短视频|剪辑|mp4|film|短片/.test(blob)) return "短视频";
  if (/research|report|文案|写作|copy|write|whitepaper/.test(blob)) return "文案";
  if (/react|html|frontend|前端|jsx|tsx|vue/.test(blob)) return "前端";
  if (/backend|后端|python|api|server|docker|swe|code|agent/.test(blob)) return "后端";
  if (/orchestrat|framework|multi-agent|通用|agent/.test(blob)) return "全栈";
  return "全栈";
}

/* ============================================================
 * 协议解析：成本分 + 商用复核判定（架构 §7.1）
 * ========================================================== */

function resolveLicense(repo: GithubRepoRaw): {
  spdx: string;
  cost: number;
  commercialReview: boolean;
} {
  const raw = (repo.license?.spdx_id ?? "NOASSERTION").toUpperCase();
  const spdx = !raw || raw === "NOASSERTION" || raw === "NULL" ? "自定义/未声明" : raw;
  let cost: number;
  let commercialReview: boolean;
  if (PERMISSIVE_LICENSE.includes(raw)) {
    cost = 5;
    commercialReview = false;
  } else if (raw.includes("NON-COMMERCIAL") || raw.includes("NC") || raw.includes("RESEARCH")) {
    cost = 2;
    commercialReview = true;
  } else if (raw.includes("AGPL") || raw.includes("GPL")) {
    cost = 3.2;
    commercialReview = true;
  } else if (raw.includes("MPL") || raw.includes("LGPL")) {
    cost = 3.8;
    commercialReview = true;
  } else {
    cost = 2.5;
    commercialReview = true;
  }
  return { spdx, cost, commercialReview };
}

/* ============================================================
 * 启发式六维（Mock 替代 MiniCPM-o，架构 §7.1 / PRD 附A）
 * ========================================================== */

function starTier(s: number): number {
  if (s >= 50000) return 5;
  if (s >= 20000) return 4.5;
  if (s >= 8000) return 4;
  if (s >= 3000) return 3.5;
  if (s >= 1000) return 3;
  if (s >= 200) return 2.5;
  return 2;
}

function readmeTier(len: number): number {
  if (len >= 8000) return 4.5;
  if (len >= 4000) return 4;
  if (len >= 1500) return 3.5;
  if (len >= 400) return 3;
  return 2.5;
}

function taskScore(stars: number, langMatches: boolean): number {
  let v = starTier(stars);
  if (langMatches) v += 0.3;
  return clamp1to5(v);
}

function qualityScore(len: number, hasRelease: boolean, hasExamples: boolean): number {
  let v = readmeTier(len);
  if (hasRelease) v += 0.3;
  if (hasExamples) v += 0.2;
  return clamp1to5(v);
}

function commScore(
  len: number,
  hasBadges: boolean,
  hasHeadings: boolean,
  topicCount: number,
  hasDocs: boolean,
): number {
  let v = readmeTier(len) - 0.5;
  if (hasBadges || hasHeadings) v += 0.3;
  if (topicCount >= 5) v += 0.3;
  if (hasDocs) v += 0.2;
  return clamp1to5(v);
}

function creativityScore(
  hasExamples: boolean,
  hasVideo: boolean,
  topicCount: number,
): number {
  let v = hasExamples ? 4 : 3;
  if (hasVideo) v += 0.5;
  if (topicCount >= 6) v += 0.3;
  return clamp1to5(v);
}

function reliabilityScore(months: number, archived: boolean, forks: number): number {
  let v: number;
  if (months <= 3) v = 5;
  else if (months <= 6) v = 4.5;
  else if (months <= 12) v = 4;
  else if (months <= 24) v = 3.5;
  else if (months <= 48) v = 3;
  else v = 2.5;
  if (archived) v *= 0.8;
  if (forks >= 1000) v += 0.2;
  return clamp1to5(v);
}

/**
 * 启发式六维 + 初审结论。末步经 `deriveQuickVerdict`（复用既有阈值）给 quick_verdict，
 * 绝不另写阈值（强约束）。返回 InitialReview（含六维 radar 对象，供市场/入职同源引用）。
 */
export function heuristicReview(
  repo: GithubRepoRaw,
  readme: ReadmeResult,
  contents: ContentsResult,
  hasRelease: boolean,
): InitialReview {
  const stars = repo.stargazers_count ?? 0;
  const forks = repo.forks_count ?? 0;
  const topics = repo.topics ?? [];
  const lang = (repo.language ?? "").toLowerCase();
  const fn = inferFunction(repo, readme);
  const langMatches =
    (fn === "前端" && (lang === "typescript" || lang === "javascript")) ||
    (fn === "后端" && (lang === "python" || lang === "go"));
  const months = ageInMonths(repo.pushed_at ?? null);
  const { spdx, cost, commercialReview } = resolveLicense(repo);

  const radar: RadarScore = {
    task: taskScore(stars, langMatches),
    quality: qualityScore(readme.len, hasRelease, contents.hasExamples),
    comm: commScore(
      readme.len,
      readme.hasBadges,
      readme.hasHeadings,
      topics.length,
      contents.hasDocs,
    ),
    creativity: creativityScore(contents.hasExamples, contents.hasVideo, topics.length),
    reliability: reliabilityScore(months, !!repo.archived, forks),
    cost,
  };

  const quick_verdict = deriveQuickVerdict(radar);

  // tag_eval 拼装（架构 §7.1 示例）
  const tag_eval: string[] = [];
  tag_eval.push(`${fn}·${repo.language ?? "开源"}`);
  if (commercialReview) tag_eval.push("🔴商用需复核");
  else tag_eval.push(`${spdx} 可商用`);
  if (stars >= 1000) tag_eval.push(`⭐${formatStars(stars)} 高人气`);
  if (months <= 3) tag_eval.push("近期活跃");

  // confidence = 可用信号数 / 6（架构 §7.1）
  let signals = 0;
  if (readme.len > 0) signals++;
  if (repo.license && repo.license.spdx_id) signals++;
  if (topics.length > 0) signals++;
  if (contents.hasExamples) signals++;
  if (hasRelease) signals++;
  if (repo.pushed_at) signals++;
  const confidence = Math.round((signals / 6) * 100) / 100;

  return { radar, tag_eval, quick_verdict, confidence };
}

/* ============================================================
 * 映射成 MarketplaceAgent（同构于 11 张 Mock）
 * ========================================================== */

/**
 * 组合出 MarketplaceAgent（source='github_import'）。
 * - profile.evaluation.radar 与 initial_review.radar **同一对象引用**（沿用 Mock 约定）。
 * - evaluation.verdict 镜像 quick_verdict（PASS→MVP / OBSERVE→OBSERVE / REJECT→FIRED）。
 * - github_meta 承载 ⭐/协议/html_url/分支/派生报价等展示数据。
 * - preset 可覆盖推断职能（预览卡手动改职能）。
 */
export function mapRepoToAgent(
  repo: GithubRepoRaw,
  readme: ReadmeResult,
  contents: ContentsResult,
  release: GithubRelease | null,
  preset?: AgentFunction,
): MarketplaceAgent {
  const fn = inferFunction(repo, readme, preset);
  const review = heuristicReview(repo, readme, contents, !!release);
  const radar = review.radar; // 同源引用

  const owner = repo.owner.login;
  const repoName = repo.name;
  const branch = repo.default_branch || "main";
  const htmlUrl =
    repo.html_url || `https://github.com/${owner}/${repoName}`;
  const stars = repo.stargazers_count ?? 0;
  const notional = clampBudget(stars, fn);
  const { spdx, commercialReview } = resolveLicense(repo);

  const github_meta: GithubImportMeta = {
    owner,
    repo: repoName,
    stars,
    forks: repo.forks_count ?? 0,
    license: spdx,
    html_url: htmlUrl,
    branch,
    pushed_at: repo.pushed_at ?? "",
    language: repo.language ?? null,
    notional_budget: notional,
    commercial_review: commercialReview,
  };

  const personaContent = `${repo.description ?? ""}\n\n${readme.text.slice(0, 1500)}`;
  const artwork: MediaRef[] = contents.thumbnails.length ? contents.thumbnails : [];
  const evaluation: Evaluation = {
    radar, // 与 initial_review.radar 同源
    user_fit: 0,
    verdict: (review.quick_verdict === "PASS"
      ? "MVP"
      : review.quick_verdict === "OBSERVE"
        ? "OBSERVE"
        : "FIRED") as Verdict,
    evidence_trace: [],
    confidence: 0.6,
  };

  const profile: CandidateProfile = {
    id: `gh-${owner}-${repoName}`,
    name: repoName,
    declared_tags: repo.topics ?? [],
    declared_budget: notional,
    persona_text: { type: "text/markdown", content: personaContent },
    video_demo: { type: "video/mp4", url: "" },
    voice_intro: { type: "audio/wav", url: "" },
    artwork,
    code_repo: {
      type: "repo/github",
      url: htmlUrl,
      lang: repo.language ?? "unknown",
    } as CodeRef,
    evaluation,
  };

  const initial_review: InitialReview = {
    radar, // 同源引用
    tag_eval: review.tag_eval,
    quick_verdict: review.quick_verdict,
    confidence: review.confidence,
  };

  return {
    profile,
    agent_function: fn,
    style_tags: repo.topics ?? [],
    source: "github_import" as AgentSource,
    avatar_url: repo.owner.avatar_url ?? "",
    work_thumbnails: contents.thumbnails,
    initial_review,
    github_meta,
  };
}

/* ============================================================
 * 编排：端到端导入（弹窗直接调用）
 * ========================================================== */

/** importRepo 的完整产物（含映射后的 agent 与原始抓取片段，供预览卡复用） */
export interface ImportRepoResult {
  agent: MarketplaceAgent;
  repo: GithubRepoRaw;
  readme: ReadmeResult;
  contents: ContentsResult;
  release: GithubRelease | null;
}

/**
 * 端到端导入：fetchRepo → fetchReadme/fetchContents/fetchReleases → mapRepoToAgent。
 * 任一 fetch 失败会抛出 GithubImportError（限流/私库/网络），供 UI 分流提示与 token 重试。
 */
export async function importRepo(
  owner: string,
  repo: string,
  token?: string,
): Promise<ImportRepoResult> {
  const raw = await fetchRepo(owner, repo, token);
  const [readme, contents, release] = await Promise.all([
    fetchReadme(owner, repo, token),
    fetchContents(owner, repo, token, raw.default_branch || "main"),
    fetchReleases(owner, repo, token),
  ]);
  const agent = mapRepoToAgent(raw, readme, contents, release);
  return { agent, repo: raw, readme, contents, release };
}
