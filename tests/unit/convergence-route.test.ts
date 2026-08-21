/**
 * tests/unit/convergence-route.test.ts
 *
 * convergence Host API 转发路由单测（mock 全局 fetch，不触真实 model-service）：
 * - POST /api/convergence/trace|score → 转发 POST + JSON body，透传上游状态码
 * - GET  /api/convergence/anchor?ownerId= → query 原样透传，不带 body
 * - POST /api/convergence/anchor → 转发 body
 * - 上游不可达 → 503；非匹配路径 → handled=false；错误方法 → 405
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { handleConvergenceRoutes } from '@electron/api/routes/convergence';
import type { HostApiContext } from '@electron/api/context';

const MODEL_SERVICE = 'http://127.0.0.1:8000';
const ctx = { modelServiceUrl: MODEL_SERVICE } as unknown as HostApiContext;

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function makeReq(method: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  return Object.assign(stream, { method, headers: {} }) as unknown as IncomingMessage;
}

interface Captured {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

function makeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, payload: undefined };
  const res = {
    statusCode: 200,
    setHeader: () => undefined,
    write: () => true,
    end(data?: unknown) {
      captured.status = res.statusCode;
      if (typeof data === 'string' && data) captured.payload = JSON.parse(data);
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

function mockUpstream(status: number, payload: unknown) {
  fetchMock.mockResolvedValueOnce({
    status,
    json: async () => payload,
  });
}

async function call(method: string, rawUrl: string, body?: unknown) {
  const { res, captured } = makeRes();
  const handled = await handleConvergenceRoutes(
    makeReq(method, body),
    res,
    new URL(rawUrl, 'http://127.0.0.1:3210'),
    ctx,
  );
  return { handled, captured };
}

describe('convergence Host API 转发路由', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('POST /api/convergence/trace → 转发 body，透传上游响应', async () => {
    mockUpstream(200, { run_id: 'run-1' });
    const body = { run_id: 'run-1', turns: [] };
    const { handled, captured } = await call('POST', '/api/convergence/trace', body);
    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(`${MODEL_SERVICE}/api/convergence/trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(captured.status).toBe(200);
    expect(captured.payload).toEqual({ run_id: 'run-1' });
  });

  it('POST /api/convergence/score → 透传上游非 200 状态码', async () => {
    mockUpstream(422, { detail: 'no trace' });
    const { captured } = await call('POST', '/api/convergence/score', { run_id: 'x' });
    expect(captured.status).toBe(422);
    expect(captured.payload).toEqual({ detail: 'no trace' });
  });

  it('GET /api/convergence/anchor?ownerId= → query 原样透传且无 body', async () => {
    mockUpstream(200, [{ anchor_id: 'a1' }]);
    const { handled, captured } = await call('GET', '/api/convergence/anchor?ownerId=boss');
    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `${MODEL_SERVICE}/api/convergence/anchor?ownerId=boss`,
      { method: 'GET' },
    );
    expect(captured.payload).toEqual([{ anchor_id: 'a1' }]);
  });

  it('POST /api/convergence/anchor → 转发 body', async () => {
    mockUpstream(200, { ok: true, anchor_id: 'a2' });
    const body = { owner_id: 'boss', note: 'pin' };
    const { captured } = await call('POST', '/api/convergence/anchor', body);
    expect(fetchMock).toHaveBeenCalledWith(`${MODEL_SERVICE}/api/convergence/anchor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(captured.status).toBe(200);
  });

  it('上游不可达 → 503（不抛异常）', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const { captured } = await call('POST', '/api/convergence/trace', {});
    expect(captured.status).toBe(503);
    expect(String(captured.payload.error)).toContain('unreachable');
  });

  it('非匹配路径 → handled=false（交下个 handler）', async () => {
    const { handled } = await call('GET', '/api/arena/compare');
    expect(handled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /api/convergence/trace（方法不允许）→ 405', async () => {
    const { handled, captured } = await call('GET', '/api/convergence/trace');
    expect(handled).toBe(true);
    expect(captured.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
