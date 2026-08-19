import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import {
  appendCapsule,
  listCapsules,
  countCapsules,
} from '../../services/experience/capsule-store';
import { getDefaultSharedBackend } from '../../services/experience/shared-capsule-backend';
import type { ExperienceCapsule, CapsuleQuery } from '../../../src/types/capsule';
import type { PublicCapsule, PublicCapsuleQuery } from '../../../src/types/public-capsule';
import type { JobType } from '../../../src/types/evaluation';

/**
 * 经验胶囊路由（MCP 等价层 · capsule.*）。
 *
 * 本地胶囊（用户私有，含交付摘要）：
 *   GET  /api/capsules              → 列出（query: jobType/agentId/approved/limit）
 *   GET  /api/capsules/count        → 总数
 *   POST /api/capsules              → 追加（回流闭环调用）
 *
 * 群体共享胶囊（脱敏后可跨用户）：
 *   GET  /api/capsules/shared          → 拉取社区共享池（query 同上）
 *   POST /api/capsules/shared          → 上传脱敏胶囊到社区
 *   POST /api/capsules/shared/import   → 导入社区包（body=PublicCapsulePackage）
 *   GET  /api/capsules/shared/export   → 导出本地共享池为社区包
 *
 * 落盘是 best-effort：POST 永不抛 500，失败返回 { ok: false } 让调用方继续。
 */
export async function handleCapsuleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  const backend = getDefaultSharedBackend();

  // —— 群体共享：导出 ——
  if (url.pathname === '/api/capsules/shared/export' && req.method === 'GET') {
    const pkg = await backend.exportPackage();
    sendJson(res, 200, pkg);
    return true;
  }

  // —— 群体共享：导入社区包 ——
  if (url.pathname === '/api/capsules/shared/import' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<unknown>(req);
      const result = await backend.importPackage(body);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 200, { imported: 0, skipped: 0, ok: false, error: String(err) });
    }
    return true;
  }

  // —— 群体共享：上传脱敏胶囊 ——
  if (url.pathname === '/api/capsules/shared' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Partial<PublicCapsule>>(req);
      if (!body || !body.capsuleId || !body.agentId) {
        sendJson(res, 400, { ok: false, error: 'capsuleId/agentId are required' });
        return true;
      }
      const ok = await backend.submitPublicCapsule(body as PublicCapsule);
      sendJson(res, ok ? 200 : 500, { ok });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: String(err) });
    }
    return true;
  }

  // —— 群体共享：拉取社区池 ——
  if (url.pathname === '/api/capsules/shared' && req.method === 'GET') {
    const query = parseSharedQuery(url);
    const capsules = await backend.fetchPublicCapsules(
      Object.keys(query).length > 0 ? query : undefined,
    );
    sendJson(res, 200, { capsules });
    return true;
  }

  // —— 本地胶囊：总数 ——
  if (url.pathname === '/api/capsules/count' && req.method === 'GET') {
    const total = await countCapsules();
    sendJson(res, 200, { total });
    return true;
  }

  // —— 本地胶囊：列表 ——
  if (url.pathname === '/api/capsules' && req.method === 'GET') {
    const query = parseLocalQuery(url);
    const capsules = await listCapsules(Object.keys(query).length > 0 ? query : undefined);
    sendJson(res, 200, { capsules });
    return true;
  }

  // —— 本地胶囊：追加 ——
  if (url.pathname === '/api/capsules' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Partial<ExperienceCapsule>>(req);
      if (!body || !body.capsuleId || !body.taskId || !body.agentId) {
        sendJson(res, 400, { ok: false, error: 'capsuleId/taskId/agentId are required' });
        return true;
      }
      const ok = await appendCapsule(body as ExperienceCapsule);
      sendJson(res, ok ? 200 : 500, { ok });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: String(err) });
    }
    return true;
  }

  return false;
}

function parseJobType(v: string | null): JobType | undefined {
  if (v === 'image' || v === 'text' || v === 'code') return v;
  return undefined;
}

function parseLocalQuery(url: URL): CapsuleQuery {
  const query: CapsuleQuery = {};
  const jobType = parseJobType(url.searchParams.get('jobType'));
  if (jobType) query.jobType = jobType;
  const agentId = url.searchParams.get('agentId') ?? undefined;
  if (agentId) query.agentId = agentId;
  const approvedParam = url.searchParams.get('approved');
  if (approvedParam === 'true') query.approved = true;
  if (approvedParam === 'false') query.approved = false;
  const limitParam = url.searchParams.get('limit');
  if (limitParam) {
    const n = Number.parseInt(limitParam, 10);
    if (Number.isFinite(n) && n > 0) query.limit = n;
  }
  return query;
}

function parseSharedQuery(url: URL): PublicCapsuleQuery {
  const query: PublicCapsuleQuery = {};
  const jobType = parseJobType(url.searchParams.get('jobType'));
  if (jobType) query.jobType = jobType;
  const agentId = url.searchParams.get('agentId') ?? undefined;
  if (agentId) query.agentId = agentId;
  const approvedParam = url.searchParams.get('approved');
  if (approvedParam === 'true') query.approved = true;
  if (approvedParam === 'false') query.approved = false;
  const limitParam = url.searchParams.get('limit');
  if (limitParam) {
    const n = Number.parseInt(limitParam, 10);
    if (Number.isFinite(n) && n > 0) query.limit = n;
  }
  return query;
}
