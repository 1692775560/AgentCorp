import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { getMemberStats, recordMemberOutcome } from '../../utils/member-stats';
import type { MemberOutcome } from '../../../src/types/performance';
import { logger } from '../../utils/logger';

/** 逐条校验上报的 outcome；非法时返回错误文案，合法返回 null。 */
function validateOutcome(item: unknown): string | null {
  if (!item || typeof item !== 'object') return 'outcome must be an object';
  const o = item as Partial<MemberOutcome>;
  if (!o.agentId || typeof o.agentId !== 'string') return 'agentId is required';
  if (typeof o.approved !== 'boolean') return 'approved must be a boolean';
  if (typeof o.rounds !== 'number' || !Number.isFinite(o.rounds) || o.rounds < 0) {
    return 'rounds must be a non-negative number';
  }
  return null;
}

/**
 * Handle member performance stats (成员绩效统计, D) API routes
 *
 * Routes:
 * - GET /api/member-stats - 全量快照（agentId → {tasks, passed, totalRounds, updatedAt}）
 * - POST /api/member-stats/record - 批量上报 [{agentId, approved, rounds}]
 *   （也接受 { outcomes: [...] } 包装），校验后逐条增量记录，返回最新快照
 */
export async function handleMemberStatsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  // GET /api/member-stats - 全量快照
  if (url.pathname === '/api/member-stats' && req.method === 'GET') {
    try {
      const stats = await getMemberStats();
      sendJson(res, 200, { success: true, stats });
    } catch (error) {
      logger.error('[member-stats] Failed to read member stats:', error);
      sendJson(res, 500, { success: false, error: String(error), stats: {} });
    }
    return true;
  }

  // POST /api/member-stats/record - 批量增量记录
  if (url.pathname === '/api/member-stats/record' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ outcomes?: unknown } | MemberOutcome[]>(req);
      const outcomes: unknown[] = Array.isArray(body) ? body : (Array.isArray(body?.outcomes) ? body.outcomes : []);
      if (outcomes.length === 0) {
        sendJson(res, 400, { success: false, error: 'outcomes must be a non-empty array' });
        return true;
      }
      for (const item of outcomes) {
        const invalid = validateOutcome(item);
        if (invalid) {
          sendJson(res, 400, { success: false, error: `Invalid outcome: ${invalid}` });
          return true;
        }
      }

      // 逐条增量记录（每条内部各自持锁读-改-写），最后回全量快照
      let stats = await getMemberStats();
      for (const outcome of outcomes as MemberOutcome[]) {
        stats = await recordMemberOutcome(outcome.agentId, {
          approved: outcome.approved,
          rounds: outcome.rounds,
        });
      }
      sendJson(res, 200, { success: true, stats });
    } catch (error) {
      logger.error('[member-stats] Failed to record member outcomes:', error);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  // Route not handled
  return false;
}
