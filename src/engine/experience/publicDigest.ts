/**
 * src/engine/experience/publicDigest.ts
 * 群体经验共享的纯函数层：脱敏 + 包导入/导出 + 群体绩效合并。
 *
 * 设计理念：
 * 把本地胶囊（ExperienceCapsule，含交付摘要等隐私面）脱敏为可跨用户
 * 共享的公共胶囊（PublicCapsule，只留评测信号）。这是群体经验共享的
 * 数据原子——脱敏后才可离开用户本地，进入社区/共享后端。
 *
 * 诚实化纪律：
 * - 脱敏是单向的：去掉的字段不可恢复，不存在「半脱敏」中间态；
 * - sourceClientHash 用非可逆 hash（不存原值），用于去重/信誉而非身份；
 * - 损坏/不合法的公共包条目跳过，合法条目仍导入；
 * - 群体绩效合并时标注 sampleSource（local/public/merged），不混淆来源。
 *
 * 纯函数、无副作用、可单测。后端协议与 Filesystem 实现在
 * electron/services/experience/shared-capsule-backend.ts。
 */
import type {
  ExperienceCapsule,
} from '@/types/capsule';
import type {
  PublicCapsule,
  PublicCapsulePackage,
  PublicCapsuleQuery,
} from '@/types/public-capsule';
import type { JobType } from '@/types/evaluation';

/**
 * 非可逆客户端 hash（不依赖 crypto 库，简单字符串 hash）。
 * 用于 sourceClientHash：去重/信誉而非身份还原。
 * 不是密码学安全 hash——用途是「同一客户端多次贡献可关联、但不暴露身份」。
 */
export function hashClientId(clientId: string): string {
  if (!clientId) return '';
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < clientId.length; i++) {
    const ch = clientId.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ ch, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * 把本地经验胶囊脱敏为公共胶囊（纯函数）。
 *
 * 去掉：taskTitle、taskDescriptionDigest、outputDigest、sessionId、
 *       sessionKey、rootSessionId（一切可能含个人/企业隐私的内容字段）。
 * 保留：jobType、radar、agentId、userFit、reworkRounds、approved、
 *       humanJudgment、createdAt、capsuleId、schemaVersion。
 * 加：sourceClientHash（可选，由调用方提供脱敏后的客户端标识）、appVersion。
 */
export function capsuleToPublic(
  capsule: ExperienceCapsule,
  opts?: { sourceClientId?: string; appVersion?: string | null },
): PublicCapsule {
  return {
    capsuleId: capsule.capsuleId,
    createdAt: capsule.createdAt,
    jobType: capsule.jobType ?? null,
    radar: capsule.radar ?? null,
    agentId: capsule.agentId,
    userFit: capsule.userFit ?? null,
    reworkRounds: capsule.reworkRounds,
    approved: capsule.approved ?? null,
    humanJudgment: capsule.humanJudgment ?? null,
    sourceClientHash: opts?.sourceClientId
      ? hashClientId(opts.sourceClientId)
      : null,
    appVersion: opts?.appVersion ?? null,
    schemaVersion: 1,
  };
}

/** 把本地胶囊列表脱敏并打包成可序列化的共享包（纯函数）。 */
export function buildPublicPackage(
  capsules: ExperienceCapsule[],
  opts?: { sourceClientId?: string; appVersion?: string | null; source?: string | null },
): PublicCapsulePackage {
  return {
    kind: 'agentcorp-public-capsules',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    capsules: capsules.map((c) => capsuleToPublic(c, opts)),
    source: opts?.source ?? null,
  };
}

/**
 * 解析群体共享包（从 JSON 字符串或已解析对象）。
 * 校验 kind/schemaVersion；损坏/不合法条目跳过，合法条目仍导入。
 * 永不抛出——返回 { ok, capsules, skipped }。
 */
export function parsePublicPackage(
  raw: string | unknown,
): { ok: boolean; capsules: PublicCapsule[]; skipped: number; error?: string } {
  let pkg: unknown;
  if (typeof raw === 'string') {
    try {
      pkg = JSON.parse(raw);
    } catch (err) {
      return { ok: false, capsules: [], skipped: 0, error: String(err) };
    }
  } else {
    pkg = raw;
  }
  if (!pkg || typeof pkg !== 'object') {
    return { ok: false, capsules: [], skipped: 0, error: 'package is not an object' };
  }
  const p = pkg as Partial<PublicCapsulePackage>;
  if (p.kind !== 'agentcorp-public-capsules') {
    return { ok: false, capsules: [], skipped: 0, error: 'kind mismatch' };
  }
  if (p.schemaVersion !== 1) {
    return { ok: false, capsules: [], skipped: 0, error: `unsupported schemaVersion ${p.schemaVersion}` };
  }
  if (!Array.isArray(p.capsules)) {
    return { ok: false, capsules: [], skipped: 0, error: 'capsules is not an array' };
  }
  const valid: PublicCapsule[] = [];
  let skipped = 0;
  for (const c of p.capsules) {
    if (
      c &&
      typeof c === 'object' &&
      typeof (c as PublicCapsule).capsuleId === 'string' &&
      typeof (c as PublicCapsule).agentId === 'string'
    ) {
      valid.push(c as PublicCapsule);
    } else {
      skipped++;
    }
  }
  return { ok: true, capsules: valid, skipped };
}

/**
 * 在公共胶囊池里检索相似工作流的群体经验（纯函数）。
 * 这是「抖音式猜你喜欢」的纯函数雏形：给定用户当前任务工种/候选 Agent，
 * 从群体池里找相似工作流的胶囊，供 matchScore 的 perfBoost 消费。
 *
 * 匹配规则同 findSimilarCapsules（jobType/agentId/approved 过滤 + 排序）。
 */
export function findSimilarPublicCapsules(
  capsules: PublicCapsule[],
  query: PublicCapsuleQuery,
): PublicCapsule[] {
  const limit = query.limit && query.limit > 0 ? query.limit : 20;
  const filtered = capsules.filter((c) => {
    if (query.jobType != null && c.jobType !== query.jobType) return false;
    if (query.agentId && c.agentId !== query.agentId) return false;
    if (query.approved != null && (c.approved ?? null) !== query.approved) return false;
    return true;
  });
  const scored = filtered.map((c) => {
    let score = 0;
    if (query.agentId && c.agentId === query.agentId) score += 4;
    if (query.jobType != null && c.jobType === query.jobType) score += 2;
    if (c.approved === true) score += 1;
    return { c, score };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.c.createdAt ?? '').localeCompare(a.c.createdAt ?? '');
  });
  return scored.slice(0, limit).map((s) => s.c);
}

/**
 * 从公共胶囊池计算某 Agent 的群体绩效摘要（与本地 summarizeAgentPerformance
 * 同结构，可合并）。供 matchScore 的 perfBoost 群体维度消费。
 *
 * 返回 null 表示无群体样本（调用方保持本地兜底，不编造）。
 */
export function summarizePublicAgentPerformance(
  capsules: PublicCapsule[],
  agentId: string,
  jobType?: JobType | null,
): {
  sampleSize: number;
  approvalRate: number;
  avgRework: number;
  avgUserFit: number | null;
} | null {
  const matching = capsules.filter(
    (c) =>
      c.agentId === agentId &&
      (jobType == null || c.jobType === jobType),
  );
  if (matching.length === 0) return null;
  const approved = matching.filter((c) => c.approved === true).length;
  const reworkSum = matching.reduce(
    (sum, c) => sum + (c.reworkRounds ?? 0),
    0,
  );
  const fitCapsules = matching.filter(
    (c) => typeof c.userFit === 'number',
  );
  const fitSum = fitCapsules.reduce(
    (sum, c) => sum + (c.userFit ?? 0),
    0,
  );
  return {
    sampleSize: matching.length,
    approvalRate: approved / matching.length,
    avgRework: reworkSum / matching.length,
    avgUserFit: fitCapsules.length > 0 ? fitSum / fitCapsules.length : null,
  };
}
