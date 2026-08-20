import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { sendJson } from '../route-utils';
import {
  listA2aTraceFiles,
  readA2aTraces,
} from '../../services/evaluation/a2a-trace';

/**
 * 历史协作 trace 浏览路由（MCP 等价层 · trace.*）。
 *
 * 把已落盘的 A2A 委派 trace（~/.openclaw/a2a-traces/<rootSessionId>.jsonl）
 * 暴露给渲染层，让「可追溯」承诺在用户侧可见：
 *   GET /api/traces                  → 列出全部 trace 文件概览（按最近活动降序）
 *   GET /api/traces/<rootSessionId>  → 读单个文件的全部 A2aTraceRecord
 *
 * 与 evaluate/arena 路由同源鉴权（x-clawx-host-session），不另开权限面。
 * 读盘失败永不抛出——返回空列表/空数组，让前端如实展示「无 trace」而非崩溃。
 */
export async function handleTraceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  // 列表
  if (url.pathname === '/api/traces' && req.method === 'GET') {
    const files = await listA2aTraceFiles();
    sendJson(res, 200, { traces: files });
    return true;
  }

  // 单文件详情：/api/traces/<rootSessionId>
  const prefix = '/api/traces/';
  if (url.pathname.startsWith(prefix) && req.method === 'GET') {
    const rawId = decodeURIComponent(url.pathname.slice(prefix.length));
    // 文件名安全化（与落盘侧 sanitizeTraceFileName 对齐，防路径穿越）
    const rootSessionId = rawId.replace(/[^A-Za-z0-9._-]/g, '_');
    if (!rootSessionId) {
      sendJson(res, 400, { success: false, error: 'rootSessionId is required' });
      return true;
    }
    const records = await readA2aTraces(rootSessionId);
    sendJson(res, 200, { rootSessionId, records });
    return true;
  }

  return false;
}
