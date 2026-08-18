import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { listTeamExperience, appendTeamExperience } from '../../utils/team-experience';
import { logger } from '../../utils/logger';

const EXPERIENCE_PATH_RE = /^\/api\/teams\/([^/]+)\/experience$/;

/**
 * Handle team experience cards (团队经验卡, F) API routes
 *
 * Routes:
 * - GET /api/teams/:teamId/experience - 该团队经验卡列表（时间升序）
 * - POST /api/teams/:teamId/experience - append 单条 {content, source}，
 *   每团队封顶 20 条（服务端裁最旧），返回该团队最新卡片列表
 *
 * 注意：/api/teams/:id/experience 与 teams.ts 的既有端点不冲突
 * （teams.ts 只匹配 /chat-events 后缀的 POST 与整 id 的 PUT/DELETE）。
 */
export async function handleTeamExperienceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  const match = url.pathname.match(EXPERIENCE_PATH_RE);
  if (!match) return false;

  const teamId = decodeURIComponent(match[1]);
  if (!teamId) {
    sendJson(res, 400, { success: false, error: 'teamId is required' });
    return true;
  }

  // GET /api/teams/:teamId/experience
  if (req.method === 'GET') {
    try {
      const cards = await listTeamExperience(teamId);
      sendJson(res, 200, { success: true, cards });
    } catch (error) {
      logger.error('[team-experience] Failed to list experience cards:', error);
      sendJson(res, 500, { success: false, error: String(error), cards: [] });
    }
    return true;
  }

  // POST /api/teams/:teamId/experience
  if (req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ content?: string; source?: string }>(req);
      if (!body.content?.trim()) {
        sendJson(res, 400, { success: false, error: 'content is required' });
        return true;
      }
      const cards = await appendTeamExperience(teamId, {
        content: body.content,
        source: body.source,
      });
      sendJson(res, 200, { success: true, cards });
    } catch (error) {
      logger.error('[team-experience] Failed to append experience card:', error);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  // 路径命中但方法不支持
  sendJson(res, 405, { success: false, error: `Method not allowed: ${req.method}` });
  return true;
}
