import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import {
  appendCapsule,
  listCapsules,
  countCapsules,
} from '../../services/experience/capsule-store';
import type { ExperienceCapsule, CapsuleQuery } from '../../../src/types/capsule';
import type { JobType } from '../../../src/types/evaluation';

/**
 * 经验胶囊路由（MCP 等价层 · capsule.*）。
 *
 * 把回流闭环产出的经验胶囊暴露给渲染层与未来生态：
 *   GET  /api/capsules              → 列出胶囊（支持 query 过滤：jobType/agentId/approved/limit）
 *   GET  /api/capsules/count        → 胶囊总数（供健康检查/仪表盘）
 *   POST /api/capsules              → 追加一颗胶囊（回流闭环调用）
 *
 * 落盘是 best-effort：POST 永不抛 500，失败返回 { ok: false } 让调用方继续。
 */
export async function handleCapsuleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  // 总数
  if (url.pathname === '/api/capsules/count' && req.method === 'GET') {
    const total = await countCapsules();
    sendJson(res, 200, { total });
    return true;
  }

  // 列表（带 query 过滤）
  if (url.pathname === '/api/capsules' && req.method === 'GET') {
    const jobTypeParam = url.searchParams.get('jobType');
    const agentId = url.searchParams.get('agentId') ?? undefined;
    const approvedParam = url.searchParams.get('approved');
    const limitParam = url.searchParams.get('limit');
    const query: CapsuleQuery = {};
    if (jobTypeParam === 'image' || jobTypeParam === 'text' || jobTypeParam === 'code') {
      query.jobType = jobTypeParam as JobType;
    }
    if (agentId) query.agentId = agentId;
    if (approvedParam === 'true') query.approved = true;
    if (approvedParam === 'false') query.approved = false;
    if (limitParam) {
      const n = Number.parseInt(limitParam, 10);
      if (Number.isFinite(n) && n > 0) query.limit = n;
    }
    const capsules = await listCapsules(Object.keys(query).length > 0 ? query : undefined);
    sendJson(res, 200, { capsules });
    return true;
  }

  // 追加
  if (url.pathname === '/api/capsules' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Partial<ExperienceCapsule>>(req);
      if (!body || !body.capsuleId || !body.taskId || !body.agentId) {
        sendJson(res, 400, { ok: false, error: 'capsuleId/taskId/agentId are required' });
        return true;
      }
      // 最小字段校验通过即落盘；落盘失败吞掉
      const ok = await appendCapsule(body as ExperienceCapsule);
      sendJson(res, ok ? 200 : 500, { ok });
    } catch (err) {
      // 与 a2a-trace 同口径：落盘失败不抛 500 给调用方阻塞，返回明确 ok=false
      sendJson(res, 200, { ok: false, error: String(err) });
    }
    return true;
  }

  return false;
}
