/**
 * tests/unit/eval-routes.test.ts
 *
 * 主进程评估数据路由单测（真实遥测链路）：
 * 直接调用 handleEvaluateRoutes（mock req/res/ctx），覆盖：
 * - GET  /api/eval/sessions      sessions.json 三种 shape + 文件名扫描兜底 + 路径穿越防护
 * - POST /api/eval/collect       有转录（真实 jsonl 派生）/ 无转录（usage 兜底派生）
 * - GET/PUT /api/eval/profiles   档案 CRUD（electron-store 用 in-memory 替身）
 * - POST/GET /api/eval/runlinks  runlink 读写（服务端补 evaluatedAt）
 *
 * sessions fixture 落在临时目录（mock getOpenClawConfigDir 指向）。
 *
 * 运行：pnpm test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── 临时 OpenClaw 配置目录（sessions fixture 根）──────────────────────────
// 与下方 vi.mock 工厂里的字面量保持一致（工厂被提升，不能引用外层变量）。
const FAKE_OPENCLAW_DIR = join(tmpdir(), 'agentcorp-eval-routes-fixtures');

vi.mock('@electron/utils/paths', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getOpenClawConfigDir: () => path.join(os.tmpdir(), 'agentcorp-eval-routes-fixtures'),
  };
});

// ── token 用量替身 ────────────────────────────────────────────────────────
const USAGE_FIXTURE = [
  {
    timestamp: '2025-01-01T00:00:00Z',
    sessionId: 'sess-ghost',
    agentId: 'ghost-agent',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 150,
    costUsd: 0.01,
  },
];

vi.mock('@electron/utils/token-usage', () => ({
  getRecentTokenUsageHistory: vi.fn(async () => USAGE_FIXTURE),
}));

// ── electron-store 替身（与 eval-stores.test.ts 同款 in-memory 实现）──────
vi.mock('electron-store', () => {
  class FakeStore {
    private data = new Map<string, unknown>();
    set(key: string, val: unknown) {
      this.data.set(key, val);
    }
    get(key: string) {
      return this.data.get(key);
    }
    get store() {
      return Object.fromEntries(this.data);
    }
  }
  return { default: FakeStore };
});

import { handleEvaluateRoutes } from '@electron/api/routes/evaluate';
import type { HostApiContext } from '@electron/api/context';

const ctx = { modelServiceUrl: 'http://127.0.0.1:9' } as unknown as HostApiContext;

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
  const handled = await handleEvaluateRoutes(
    makeReq(method, body),
    res,
    new URL(rawUrl, 'http://127.0.0.1:3210'),
    ctx,
  );
  return { handled, ...captured };
}

function sessionsDirOf(agentId: string): string {
  return join(FAKE_OPENCLAW_DIR, 'agents', agentId, 'sessions');
}

function writeSessionsJson(agentId: string, content: unknown): void {
  const dir = sessionsDirOf(agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify(content), 'utf8');
}

beforeEach(() => {
  rmSync(FAKE_OPENCLAW_DIR, { recursive: true, force: true });
  mkdirSync(FAKE_OPENCLAW_DIR, { recursive: true });
});

describe('GET /api/eval/sessions', () => {
  it('shape A：sessions 数组（key/sessionId + file 字段），按 updatedAt 降序', async () => {
    writeSessionsJson('sa', {
      sessions: [
        { key: 'agent:sa:main', sessionId: 'uuid-a1', updatedAt: '2025-01-02T00:00:00.000Z' },
        { key: 'agent:sa:sub', file: 'uuid-a2.jsonl', updatedAt: '2025-01-03T00:00:00.000Z' },
      ],
    });
    const r = await call('GET', '/api/eval/sessions?agentId=sa');
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.payload.success).toBe(true);
    expect(r.payload.sessions).toEqual([
      { sessionKey: 'agent:sa:sub', sessionId: 'uuid-a2', updatedAt: '2025-01-03T00:00:00.000Z' },
      { sessionKey: 'agent:sa:main', sessionId: 'uuid-a1', updatedAt: '2025-01-02T00:00:00.000Z' },
    ]);
  });

  it('shape B：扁平 key→对象（sessionId + 毫秒数字 updatedAt 归一为 ISO）', async () => {
    writeSessionsJson('sb', {
      'agent:sb:main': { sessionId: 'uuid-b1', updatedAt: 1735689600000 },
    });
    const r = await call('GET', '/api/eval/sessions?agentId=sb');
    expect(r.payload.sessions).toEqual([
      { sessionKey: 'agent:sb:main', sessionId: 'uuid-b1', updatedAt: '2025-01-01T00:00:00.000Z' },
    ]);
  });

  it('shape C：扁平 key→文件名字符串', async () => {
    writeSessionsJson('sc', { 'agent:sc:main': 'uuid-c1.jsonl' });
    const r = await call('GET', '/api/eval/sessions?agentId=sc');
    expect(r.payload.sessions).toEqual([
      { sessionKey: 'agent:sc:main', sessionId: 'uuid-c1', updatedAt: '' },
    ]);
  });

  it('兜底：无 sessions.json 时扫描 *.jsonl（排除 .deleted.），sessionKey 重建', async () => {
    const dir = sessionsDirOf('sd');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'uuid-d1.jsonl'), '{}\n', 'utf8');
    writeFileSync(join(dir, 'uuid-d2.deleted.jsonl'), '{}\n', 'utf8');
    writeFileSync(join(dir, 'notes.txt'), 'x', 'utf8');
    const r = await call('GET', '/api/eval/sessions?agentId=sd');
    expect(r.payload.success).toBe(true);
    expect(r.payload.sessions).toHaveLength(1);
    expect(r.payload.sessions[0].sessionId).toBe('uuid-d1');
    expect(r.payload.sessions[0].sessionKey).toBe('agent:sd:uuid-d1');
    expect(r.payload.sessions[0].updatedAt).not.toBe('');
  });

  it('agentId 路径穿越 → 400', async () => {
    const r = await call('GET', `/api/eval/sessions?agentId=${encodeURIComponent('../..')}`);
    expect(r.status).toBe(400);
    expect(r.payload.success).toBe(false);
  });

  it('agentId 缺失 → 400', async () => {
    const r = await call('GET', '/api/eval/sessions');
    expect(r.status).toBe(400);
  });
});

describe('POST /api/eval/collect', () => {
  it('有转录：从真实 jsonl 派生 TelemetryEvent（latency = 首末时间差）', async () => {
    const dir = sessionsDirOf('route-agent');
    mkdirSync(dir, { recursive: true });
    const line = (ts: string, input: number, output: number) =>
      JSON.stringify({
        timestamp: ts,
        message: { role: 'assistant', usage: { input, output, total: input + output } },
      });
    writeFileSync(
      join(dir, 'uuid-r1.jsonl'),
      `${line('2025-01-01T00:00:00Z', 100, 50)}\n${line('2025-01-01T00:01:00Z', 200, 80)}\n`,
      'utf8',
    );
    const r = await call('POST', '/api/eval/collect', {
      agentId: 'route-agent',
      sessionId: 'uuid-r1',
    });
    expect(r.status).toBe(200);
    expect(r.payload.success).toBe(true);
    expect(r.payload.transcript).toContain('assistant');
    expect(r.payload.events).toHaveLength(1);
    expect(r.payload.events[0].latency_ms).toBe(60_000);
    expect(r.payload.events[0].agent_id).toBe('route-agent');
    expect(r.payload.events[0].task_id).toBe('uuid-r1');
  });

  it('无转录：回退 usage 派生最小遥测，transcript 为空', async () => {
    const r = await call('POST', '/api/eval/collect', {
      agentId: 'ghost-agent',
      sessionId: 'sess-ghost',
    });
    expect(r.status).toBe(200);
    expect(r.payload.transcript).toBe('');
    expect(r.payload.entries.length).toBeGreaterThan(0);
    expect(r.payload.events.length).toBeGreaterThan(0);
    expect(r.payload.events[0].agent_id).toBe('ghost-agent');
    expect(r.payload.events[0].success).toBe(true);
  });

  it('agentId 与 sessionId 均缺失 → 400', async () => {
    const r = await call('POST', '/api/eval/collect', {});
    expect(r.status).toBe(400);
    expect(r.payload.success).toBe(false);
  });
});

describe('profiles 路由', () => {
  it('PUT → GET 列表 → GET 单份 往返一致；缺失返回 null', async () => {
    const profile = { agentId: 'route-p1', lifecycle: 'ACTIVE', runIds: [] };
    const put = await call('PUT', '/api/eval/profiles', profile);
    expect(put.status).toBe(200);
    expect(put.payload.success).toBe(true);

    const list = await call('GET', '/api/eval/profiles');
    expect(list.payload.profiles.some((p: { agentId: string }) => p.agentId === 'route-p1')).toBe(
      true,
    );

    const one = await call('GET', '/api/eval/profiles/route-p1');
    expect(one.payload.profile.agentId).toBe('route-p1');

    const missing = await call('GET', '/api/eval/profiles/no-such-agent');
    expect(missing.status).toBe(200);
    expect(missing.payload.profile).toBeNull();
  });

  it('PUT 缺 agentId → 400', async () => {
    const r = await call('PUT', '/api/eval/profiles', { lifecycle: 'ACTIVE' });
    expect(r.status).toBe(400);
  });
});

describe('runlinks 路由', () => {
  it('POST 服务端补 evaluatedAt → GET 回读；缺失返回 null', async () => {
    const post = await call('POST', '/api/eval/runlinks', {
      runId: 'run-r1',
      taskId: 'task-1',
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      sessionId: 'sess-1',
    });
    expect(post.status).toBe(200);
    expect(post.payload.link.runId).toBe('run-r1');
    expect(typeof post.payload.link.evaluatedAt).toBe('string');

    const get = await call('GET', '/api/eval/runlinks/run-r1');
    expect(get.payload.link.runId).toBe('run-r1');
    expect(get.payload.link.taskId).toBe('task-1');

    const missing = await call('GET', '/api/eval/runlinks/does-not-exist');
    expect(missing.status).toBe(200);
    expect(missing.payload.link).toBeNull();
  });

  it('POST 缺 runId → 400', async () => {
    const r = await call('POST', '/api/eval/runlinks', { agentId: 'a1' });
    expect(r.status).toBe(400);
  });
});
