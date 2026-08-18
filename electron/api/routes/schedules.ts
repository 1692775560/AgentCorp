import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
} from '../../utils/schedule-config';
import type { CreateScheduleRequest, UpdateScheduleRequest } from '../../../src/types/schedule';
import { logger } from '../../utils/logger';

/**
 * Handle team schedule (定时任务) API routes
 *
 * Routes:
 * - GET /api/schedules?teamId= - List schedules (optionally filtered by team)
 * - POST /api/schedules - Create a schedule
 * - PUT /api/schedules/:scheduleId - Update a schedule
 * - DELETE /api/schedules/:scheduleId - Delete a schedule
 */
export async function handleScheduleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  // GET /api/schedules - List all schedules (optional ?teamId= filter)
  if (url.pathname === '/api/schedules' && req.method === 'GET') {
    try {
      const teamId = url.searchParams.get('teamId');
      const all = await listSchedules();
      const schedules = teamId ? all.filter((schedule) => schedule.teamId === teamId) : all;
      sendJson(res, 200, { success: true, schedules });
    } catch (error) {
      logger.error('[schedules] Failed to list schedules:', error);
      sendJson(res, 500, { success: false, error: String(error), schedules: [] });
    }
    return true;
  }

  // POST /api/schedules - Create a schedule
  if (url.pathname === '/api/schedules' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<CreateScheduleRequest>(req);

      if (!body.teamId) {
        sendJson(res, 400, { success: false, error: 'teamId is required' });
        return true;
      }
      if (!body.title?.trim()) {
        sendJson(res, 400, { success: false, error: 'title is required' });
        return true;
      }
      if (!body.instruction?.trim()) {
        sendJson(res, 400, { success: false, error: 'instruction is required' });
        return true;
      }
      if (!body.cron?.trim()) {
        sendJson(res, 400, { success: false, error: 'cron is required' });
        return true;
      }

      await createSchedule(body);

      // Return all schedules after creation (following teams.ts pattern)
      const schedules = await listSchedules();
      sendJson(res, 200, { success: true, schedules });
    } catch (error) {
      logger.error('[schedules] Failed to create schedule:', error);
      // cron 校验失败等输入错误返回 400
      if (String(error).includes('Invalid cron expression')) {
        sendJson(res, 400, { success: false, error: String(error) });
      } else {
        sendJson(res, 500, { success: false, error: String(error) });
      }
    }
    return true;
  }

  // PUT /api/schedules/:scheduleId - Update a schedule
  if (url.pathname.startsWith('/api/schedules/') && req.method === 'PUT') {
    try {
      const scheduleId = decodeURIComponent(url.pathname.slice('/api/schedules/'.length));

      if (!scheduleId) {
        sendJson(res, 400, { success: false, error: 'scheduleId is required' });
        return true;
      }

      const body = await parseJsonBody<UpdateScheduleRequest>(req);
      await updateSchedule(scheduleId, body);

      const schedules = await listSchedules();
      sendJson(res, 200, { success: true, schedules });
    } catch (error) {
      logger.error('[schedules] Failed to update schedule:', error);

      if (String(error).includes('not found')) {
        sendJson(res, 404, { success: false, error: String(error) });
      } else if (String(error).includes('Invalid cron expression')) {
        sendJson(res, 400, { success: false, error: String(error) });
      } else {
        sendJson(res, 500, { success: false, error: String(error) });
      }
    }
    return true;
  }

  // DELETE /api/schedules/:scheduleId - Delete a schedule
  if (url.pathname.startsWith('/api/schedules/') && req.method === 'DELETE') {
    try {
      const scheduleId = decodeURIComponent(url.pathname.slice('/api/schedules/'.length));

      if (!scheduleId) {
        sendJson(res, 400, { success: false, error: 'scheduleId is required' });
        return true;
      }

      await deleteSchedule(scheduleId);

      const schedules = await listSchedules();
      sendJson(res, 200, { success: true, schedules });
    } catch (error) {
      logger.error('[schedules] Failed to delete schedule:', error);

      if (String(error).includes('not found')) {
        sendJson(res, 404, { success: false, error: String(error) });
      } else {
        sendJson(res, 500, { success: false, error: String(error) });
      }
    }
    return true;
  }

  // Route not handled
  return false;
}
