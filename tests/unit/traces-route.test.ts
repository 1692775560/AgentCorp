/**
 * tests/unit/traces-route.test.ts
 *
 * 历史协作 trace 浏览路由单测：
 * 直接调用 handleTraceRoutes（mock req/res/ctx），覆盖：
 * - GET /api/traces              空目录 / 多 jsonl 文件（按最近活动降序）
 * - GET /api/traces?taskId=      团队任务过滤：只列含该任务记录的文件
 * - GET /api/traces/<id>         存在 → records 升序；不存在 → []；空 id → 400
 * - GET /api/traces/<id>?taskId= 详情按 task_id 过滤
 * - POST /api/traces             渲染层团队任务 trace 落盘（合法写入 / 坏记录丢弃 / 非 JSON → 400）
 * - 路径穿越防护（id 含 ../ → sanitize 后读，绝不越出 a2a-traces 目录）
 * - 非匹配路径 → handled=false（让下个 handler 接管）
 *
 * fixture 落在临时目录（mock getOpenClawConfigDir 指向）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_OPENCLAW_DIR = join(tmpdir(), 'agentcorp-traces-routes-fixtures');

vi.mock('@electron/utils/paths', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getOpenClawConfigDir: () => path.join(os.tmpdir(), 'agentcorp-traces-routes-fixtures'),
  };
});

import { handleTraceRoutes } from '@electron/api/routes/traces';
import type { HostApiContext } from '@electron/api/context';

const ctx = {} as unknown as HostApiContext;

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

async function call(method: string, rawUrl: string, body?: unknown) {
  const { res, captured } = makeRes();
  const handled = await handleTraceRoutes(
    makeReq(method, body),
    res,
    new URL(rawUrl, 'http://127.0.0.1:3210'),
    ctx,
  );
  return { handled, ...captured };
}

function tracesDir(): string {
  return join(FAKE_OPENCLAW_DIR, 'a2a-traces');
}

/** 构造一条合法 A2aTraceRecord 的 JSON 字符串（追加换行，符合 jsonl 格式）。 */
function recordLine(overrides: Partial<{
  trace_id: string;
  task_id: string;
  delegator: string;
  delegatee: string;
  state: string;
  kind: string;
  sent_at: string;
  summary: string;
  root_session_id: string;
  cost_usd: number;
  tokens: number;
  latency_ms: number;
}>): string {
  return JSON.stringify({
    trace_id: overrides.trace_id ?? 't-1',
    task_id: overrides.task_id ?? 'task-1',
    parent_task_id: null,
    delegator: overrides.delegator ?? 'agent:leader',
    delegatee: overrides.delegatee ?? 'agent:worker',
    round: 1,
    kind: overrides.kind ?? 'message',
    state: overrides.state ?? 'completed',
    rework_of: null,
    channel: 'internal-rpc',
    sent_at: overrides.sent_at ?? '2025-01-01T00:00:00Z',
    completed_at: overrides.sent_at ?? '2025-01-01T00:00:00Z',
    summary: overrides.summary ?? '示例委派',
    session_key: 'agent:leader:sess-1',
    root_session_id: overrides.root_session_id ?? 'root-1',
    trigger: 'spawn',
    cost_usd: overrides.cost_usd ?? 0.0012,
    tokens: overrides.tokens ?? 800,
    latency_ms: overrides.latency_ms ?? 320,
  });
}

function writeTraceFile(rootSessionId: string, lines: string[]): void {
  const dir = tracesDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${rootSessionId}.jsonl`), lines.join('\n') + '\n', 'utf8');
}

beforeEach(() => {
  rmSync(FAKE_OPENCLAW_DIR, { recursive: true, force: true });
  mkdirSync(FAKE_OPENCLAW_DIR, { recursive: true });
});

describe('GET /api/traces（列表）', () => {
  it('空目录 → { traces: [] }', async () => {
    const { handled, status, payload } = await call('GET', '/api/traces');
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(payload).toEqual({ traces: [] });
  });

  it('目录不存在时也返回空列表（永不抛出）', async () => {
    rmSync(FAKE_OPENCLAW_DIR, { recursive: true, force: true });
    const { handled, status, payload } = await call('GET', '/api/traces');
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(payload).toEqual({ traces: [] });
  });

  it('多 jsonl 文件 → 按最近活动降序，含概览字段', async () => {
    writeTraceFile('root-old', [recordLine({
      trace_id: 'a', sent_at: '2025-01-01T00:00:00Z', root_session_id: 'root-old',
    })]);
    writeTraceFile('root-new', [
      recordLine({
        trace_id: 'b', sent_at: '2025-01-02T00:00:00Z', root_session_id: 'root-new',
      }),
      recordLine({
        trace_id: 'c', sent_at: '2025-01-02T12:00:00Z', root_session_id: 'root-new',
      }),
    ]);
    const { handled, status, payload } = await call('GET', '/api/traces');
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(payload.traces).toHaveLength(2);
    // 最近活动降序：root-new（12:00）在前
    expect(payload.traces[0].rootSessionId).toBe('root-new');
    expect(payload.traces[0].recordCount).toBe(2);
    expect(payload.traces[0].lastSentAt).toBe('2025-01-02T12:00:00Z');
    expect(payload.traces[0].firstSentAt).toBe('2025-01-02T00:00:00Z');
    expect(payload.traces[1].rootSessionId).toBe('root-old');
    expect(payload.traces[1].recordCount).toBe(1);
    expect(typeof payload.traces[0].sizeBytes).toBe('number');
  });

  it('非 jsonl 文件被忽略', async () => {
    mkdirSync(tracesDir(), { recursive: true });
    writeFileSync(join(tracesDir(), 'README.md'), '# not a trace', 'utf8');
    writeTraceFile('root-1', [recordLine({})]);
    const { payload } = await call('GET', '/api/traces');
    expect(payload.traces).toHaveLength(1);
    expect(payload.traces[0].rootSessionId).toBe('root-1');
  });
});

describe('GET /api/traces/<rootSessionId>（详情）', () => {
  it('存在 → records 按 sent_at 升序返回', async () => {
    writeTraceFile('root-1', [
      recordLine({ trace_id: 'late', sent_at: '2025-01-01T12:00:00Z' }),
      recordLine({ trace_id: 'early', sent_at: '2025-01-01T00:00:00Z' }),
    ]);
    const { handled, status, payload } = await call('GET', '/api/traces/root-1');
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(payload.rootSessionId).toBe('root-1');
    expect(payload.records).toHaveLength(2);
    // 升序：early 在前
    expect(payload.records[0].trace_id).toBe('early');
    expect(payload.records[1].trace_id).toBe('late');
    // 扩展字段保留
    expect(payload.records[0].cost_usd).toBe(0.0012);
    expect(payload.records[0].tokens).toBe(800);
  });

  it('不存在 → { records: [] }（永不抛出）', async () => {
    const { handled, status, payload } = await call('GET', '/api/traces/never-exists');
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(payload).toEqual({ rootSessionId: 'never-exists', records: [] });
  });

  it('空 id → 400', async () => {
    // /api/traces/ 带尾部斜杠 → slice 后为空
    const { handled, status, payload } = await call('GET', '/api/traces/');
    expect(handled).toBe(true);
    expect(status).toBe(400);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/rootSessionId/);
  });

  it('路径穿越防护：含 ../ 的 id 被 sanitize 后读（不越出 trace 目录）', async () => {
    writeTraceFile('safe-id', [recordLine({ trace_id: 'ok' })]);
    // 构造一个含目录穿越片段的 id；sanitize 会把 / 换成 _
    const evil = '..%2F..%2F..%2Fetc%2Fpasswd';
    const { status, payload } = await call('GET', `/api/traces/${evil}`);
    // 不论能否读到，都不得越出 a2a-traces 目录、不得抛 500
    expect([200, 400]).toContain(status);
    if (status === 200) {
      expect(payload).toHaveProperty('records');
    }
  });

  it('损坏行被跳过，合法行仍返回', async () => {
    writeTraceFile('mixed', [
      recordLine({ trace_id: 'good-1', sent_at: '2025-01-01T00:00:00Z' }),
      'this is not json',
      '',
      recordLine({ trace_id: 'good-2', sent_at: '2025-01-01T01:00:00Z' }),
    ]);
    const { payload } = await call('GET', '/api/traces/mixed');
    expect(payload.records).toHaveLength(2);
    expect(payload.records[0].trace_id).toBe('good-1');
    expect(payload.records[1].trace_id).toBe('good-2');
  });
});

describe('GET /api/traces?taskId=（团队任务过滤）', () => {
  it('列表按 taskId 过滤：只保留含该任务记录的文件', async () => {
    writeTraceFile('root-a', [recordLine({ trace_id: 'a1', task_id: 'task-A', root_session_id: 'root-a' })]);
    writeTraceFile('root-b', [recordLine({ trace_id: 'b1', task_id: 'task-B', root_session_id: 'root-b' })]);
    const { handled, status, payload } = await call('GET', '/api/traces?taskId=task-A');
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(payload.traces).toHaveLength(1);
    expect(payload.traces[0].rootSessionId).toBe('root-a');
  });

  it('详情按 taskId 过滤：只返回该任务的 records', async () => {
    writeTraceFile('root-mix', [
      recordLine({ trace_id: 'm1', task_id: 'task-A', root_session_id: 'root-mix', sent_at: '2025-01-01T00:00:00Z' }),
      recordLine({ trace_id: 'm2', task_id: 'task-B', root_session_id: 'root-mix', sent_at: '2025-01-01T00:01:00Z' }),
    ]);
    const { status, payload } = await call('GET', '/api/traces/root-mix?taskId=task-B');
    expect(status).toBe(200);
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0].trace_id).toBe('m2');
  });
});

describe('POST /api/traces（渲染层团队任务 trace 落盘）', () => {
  it('合法 records 追加落盘，随后可读回', async () => {
    const record = JSON.parse(recordLine({
      trace_id: 'post-1', task_id: 'task-squad', root_session_id: 'root-squad',
    }));
    const { handled, status, payload } = await call('POST', '/api/traces', { records: [record] });
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(payload).toEqual({ success: true, appended: 1 });

    const detail = await call('GET', '/api/traces/root-squad');
    expect(detail.payload.records).toHaveLength(1);
    expect(detail.payload.records[0].trace_id).toBe('post-1');
  });

  it('缺 root_session_id 的记录被丢弃，不写入', async () => {
    const { status, payload } = await call('POST', '/api/traces', {
      records: [{ trace_id: 'bad-1' }, JSON.parse(recordLine({ trace_id: 'good-1', root_session_id: 'root-post' }))],
    });
    expect(status).toBe(200);
    expect(payload).toEqual({ success: true, appended: 1 });
    const detail = await call('GET', '/api/traces/root-post');
    expect(detail.payload.records).toHaveLength(1);
  });

  it('非 JSON body → 400，不抛出', async () => {
    const { res, captured } = makeRes();
    const stream = Readable.from(['not-json{{{']);
    const req = Object.assign(stream, { method: 'POST', headers: {} }) as unknown as IncomingMessage;
    const handled = await handleTraceRoutes(req, res, new URL('/api/traces', 'http://127.0.0.1:3210'), ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect(captured.payload.success).toBe(false);
  });
});

describe('路由分派', () => {
  it('非 /api/traces 前缀 → handled=false（交下个 handler）', async () => {
    const { handled } = await call('GET', '/api/approvals');
    expect(handled).toBe(false);
  });

  it('PUT /api/traces → handled=false（未支持的方法）', async () => {
    const { handled } = await call('PUT', '/api/traces');
    expect(handled).toBe(false);
  });
});
