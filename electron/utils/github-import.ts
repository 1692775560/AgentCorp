/**
 * electron/utils/github-import.ts
 * GitHub 开源 Agent 一键导入。
 *
 * 为什么放主进程：需要出网请求与（可选）凭据，两者都不能进渲染层；
 * 同时 SSRF 防护必须在一个渲染层改不动的地方做。
 *
 * 设计边界（每条都对应一个具体攻击面或误判）：
 * 1. **只允许 api.github.com**：输入先解析成 {owner, repo}，再由本模块自己拼 URL，
 *    绝不把用户输入当 URL 直接 fetch —— 否则 `https://evil/..%2f` 之类就能打内网。
 * 2. **不跟随跨主机重定向**：redirect: 'manual'，非 2xx 一律按失败处理。
 * 3. **响应体积上限 + 超时**：防止被超大响应拖死主进程。
 * 4. **凭据只读环境变量**（GITHUB_TOKEN），不落盘、不回传渲染层、不进日志。
 * 5. **导入 ≠ 评测通过**：导入只产生候选档案，六维一律留空由 S1/S2 实测填充。
 *    这里绝不用 star 数折算能力分 —— 那正是本项目要消灭的东西。
 *    star / fork / 活跃度只作为**展示信息**与「维护活跃度」这一条事实呈现。
 *
 * 本模块**刻意不 import electron**（连 logger 都不引）：解析与映射是纯函数，
 * 保持零 electron 依赖才能在 node 环境直接单测 —— 安全加固的用例必须能跑，
 * 否则「已加固」就只是一句注释。日志由调用方（ipc-handlers）记录。
 */

/** 解析出的仓库引用 */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** GitHub 导入的元信息（展示用，不参与能力打分） */
export interface GithubImportMeta {
  owner: string;
  repo: string;
  stars: number;
  forks: number;
  openIssues: number;
  license: string;
  htmlUrl: string;
  branch: string;
  pushedAt: string;
  language: string | null;
  topics: string[];
  /** 距最近一次 push 的天数（活跃度事实，不是分数） */
  daysSincePush: number | null;
}

/** 导入结果：一个可进入人才市集的候选卡 */
export interface GithubCandidate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  hireType: 'single';
  price: string;
  avatar: string;
  /** 与本地模板卡的 rating 字段同形，但导入卡固定为 null：未实测不给分 */
  rating: null;
  hiredCount: number;
  source: 'github_import';
  githubMeta: GithubImportMeta;
  /** 推断的工种（供市集筛选），无法判断时为 null —— 不猜 */
  jobType: 'code' | 'text' | 'image' | null;
}

export class GithubImportError extends Error {}

const API_HOST = 'api.github.com';
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 512 * 1024;
/** GitHub 的 owner/repo 命名规则（保守版：不接受任何可能改变 URL 语义的字符） */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * 把用户输入解析为 {owner, repo}。
 *
 * 接受：
 *   https://github.com/owner/repo(.git)(/tree/main…)
 *   github.com/owner/repo
 *   owner/repo
 * 拒绝：其它主机、缺段、含路径穿越或非法字符的输入。
 *
 * 纯函数，可单测；这是整条链路的第一道也是最重要的一道闸门。
 */
export function parseRepoRef(input: string): RepoRef {
  const raw = (input ?? '').trim();
  if (!raw) throw new GithubImportError('请输入 GitHub 仓库地址或 owner/repo');

  let path = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.toLowerCase().startsWith('github.com/')) {
    let url: URL;
    try {
      url = new URL(raw.toLowerCase().startsWith('github.com/') ? `https://${raw}` : raw);
    } catch {
      throw new GithubImportError('无法解析该地址');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new GithubImportError('只支持 http(s) 形式的 GitHub 地址');
    }
    const host = url.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') {
      throw new GithubImportError(`只支持 github.com，收到：${host}`);
    }
    path = url.pathname;
  }

  const segments = path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length < 2) {
    throw new GithubImportError('地址里看不出 owner/repo，例如 openai/openai-python');
  }
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');

  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) {
    throw new GithubImportError('owner/repo 含非法字符');
  }
  return { owner, repo };
}

/** GitHub API 原始响应里我们真正会用到的字段 */
interface RawRepo {
  name?: string;
  full_name?: string;
  description?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  license?: { spdx_id?: string | null; name?: string | null } | null;
  html_url?: string;
  default_branch?: string;
  pushed_at?: string;
  language?: string | null;
  topics?: string[];
  owner?: { login?: string; avatar_url?: string } | null;
  archived?: boolean;
  disabled?: boolean;
}

/** 文本清洗：去控制字符、压空白、截断。防止把奇怪内容塞进 UI 或后续 prompt。 */
export function sanitizeText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** 由主语言与 topics 推断工种；判断不了就返回 null（不猜） */
export function inferJobType(
  language: string | null | undefined,
  topics: string[],
): 'code' | 'text' | 'image' | null {
  const bag = [String(language ?? '').toLowerCase(), ...topics.map((t) => t.toLowerCase())];
  const has = (...keys: string[]) => keys.some((k) => bag.some((b) => b.includes(k)));
  if (has('diffusion', 'image', 'vision', 'comfyui', 'text-to-image', 'design')) return 'image';
  if (has('writing', 'copywriting', 'content', 'translation', 'summariz', 'chatbot')) return 'text';
  if (
    has('python', 'typescript', 'javascript', 'go', 'rust', 'java', 'c++', 'code', 'coding', 'devtools')
  ) {
    return 'code';
  }
  return null;
}

/** 天数差（用于「维护活跃度」这条事实，不折算成分数） */
export function daysSince(iso: string | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.floor((now - ts) / 86_400_000));
}

/**
 * 把 GitHub API 响应映射为候选卡（纯函数，可单测）。
 *
 * 关键约定：**不产生任何能力分**。rating 恒为 null，六维留空，
 * 由 S1 初审 / S2 试做题实测填充。star 数只出现在 githubMeta 里供展示，
 * 绝不参与排序打分 —— 否则新发布的 agent 又要输在起跑线上，
 * 而这正是 AgentCorp 存在的理由。
 */
export function mapRepoToCandidate(raw: RawRepo, ref: RepoRef, now?: number): GithubCandidate {
  const owner = sanitizeText(raw.owner?.login, 100) || ref.owner;
  const repo = sanitizeText(raw.name, 100) || ref.repo;
  const topics = Array.isArray(raw.topics)
    ? raw.topics.map((t) => sanitizeText(t, 32)).filter(Boolean).slice(0, 8)
    : [];
  const language = raw.language ? sanitizeText(raw.language, 32) : null;
  const licenseId = sanitizeText(raw.license?.spdx_id ?? raw.license?.name, 40);
  const pushedAt = sanitizeText(raw.pushed_at, 40);

  const tags = [...new Set([language, ...topics].filter((t): t is string => Boolean(t)))].slice(0, 6);
  const description =
    sanitizeText(raw.description, 300) || '该仓库未填写简介，能力以实测结果为准。';

  return {
    id: `gh:${owner}/${repo}`.toLowerCase(),
    name: repo,
    description,
    tags: tags.length > 0 ? tags : ['未标注'],
    hireType: 'single',
    // 开源项目本身不定价：报价留给使用者按实际推理成本填，不编造数字
    price: '自建成本',
    avatar:
      sanitizeText(raw.owner?.avatar_url, 300) ||
      `https://api.dicebear.com/7.x/pixel-art/svg?seed=${encodeURIComponent(repo)}&backgroundColor=FFD233`,
    rating: null,
    hiredCount: 0,
    source: 'github_import',
    jobType: inferJobType(language, topics),
    githubMeta: {
      owner,
      repo,
      stars: Number(raw.stargazers_count ?? 0) || 0,
      forks: Number(raw.forks_count ?? 0) || 0,
      openIssues: Number(raw.open_issues_count ?? 0) || 0,
      license: licenseId && licenseId !== 'NOASSERTION' ? licenseId : '未声明',
      htmlUrl: `https://github.com/${owner}/${repo}`,
      branch: sanitizeText(raw.default_branch, 100) || 'main',
      pushedAt,
      language,
      topics,
      daysSincePush: daysSince(pushedAt, now),
    },
  };
}

/** 出网请求（超时 + 体积上限 + 不跟随跨站重定向） */
async function githubGet(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'AgentCorp-Import',
      'x-github-api-version': '2022-11-28',
    };
    // 可选凭据：只读环境变量，绝不落盘 / 不回传渲染层 / 不进日志
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) headers.authorization = `Bearer ${token}`;

    const res = await fetch(`https://${API_HOST}${path}`, {
      headers,
      signal: controller.signal,
      redirect: 'manual',
    });

    if (res.status === 404) throw new GithubImportError('仓库不存在或为私有仓库');
    if (res.status === 403 || res.status === 429) {
      throw new GithubImportError(
        'GitHub API 限流（未认证时每小时 60 次）。可设置 GITHUB_TOKEN 环境变量后重试',
      );
    }
    if (res.status >= 300 && res.status < 400) {
      throw new GithubImportError('该地址发生了重定向，出于安全考虑未跟随，请使用规范的仓库地址');
    }
    if (!res.ok) throw new GithubImportError(`GitHub 返回 ${res.status}`);

    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) throw new GithubImportError('响应过大，已中止');
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new GithubImportError('响应过大，已中止');
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof GithubImportError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GithubImportError('请求 GitHub 超时（10s）');
    }
    throw new GithubImportError(`无法访问 GitHub：${error instanceof Error ? error.message : error}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 导入一个 GitHub 仓库为候选 agent。
 * 失败一律抛 GithubImportError（文案面向用户，不含内部细节 / 不含 token）。
 */
export async function importGithubRepo(input: string): Promise<GithubCandidate> {
  const ref = parseRepoRef(input);
  const raw = (await githubGet(`/repos/${ref.owner}/${ref.repo}`)) as RawRepo;
  if (!raw || typeof raw !== 'object') {
    throw new GithubImportError('GitHub 返回了无法解析的内容');
  }
  if (raw.disabled) throw new GithubImportError('该仓库已被禁用');
  return mapRepoToCandidate(raw, ref);
}
