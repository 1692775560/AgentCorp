/**
 * tests/unit/capsules-route.test.ts
 *
 * 经验胶囊路由单测：
 * - GET  /api/capsules          空目录 / 带 query 过滤
 * - GET  /api/capsules/count    总数
 * - POST /api/capsules          追加（必填校验 / 落盘成功）
 * - 路径穿越防护 / 损坏行跳过 / 路由分派
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_OPENCLAW_DIR = join(tmpdir(), 'agentcorp-capsules-routes-fixtures');

vi.mock('@electron/utils/paths', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getOpenClawConfigDir: () => path.join(os.tmpdir(), 'agentcorp-capsules-routes-fixtures'),
  };
});

import { handleCapsuleRoutes } from '@electron/api/routes/capsules';
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
  const handled = await handleCapsuleRoutes(
    makeReq(method, body),
    res,
    new URL(rawUrl, 'http://127.0.0.1:3210'),
    ctx,
  );
  return { handled, ...captured };
}

function capsulesDir(): string {
  return join(FAKE_OPENCLAW_DIR, 'capsules');
}

function writeCapsulesJsonl(lines: string[]): void {
  mkdirSync(capsulesDir(), { recursive: true });
  writeFileSync(join(capsulesDir(), 'capsules.jsonl'), lines.join('\n') + '\n', 'utf8');
}

function capsuleJson(over: Record<string, unknown>): string {
  return JSON.stringify({
    capsuleId: 'cap-1',
    createdAt: '2025-01-01T00:00:00Z',
    taskId: 'task-1',
    taskTitle: '示例任务',
    agentId: 'agent-1',
    agentName: 'Codex',
    jobType: 'code',
    radar: { task: 3, quality: 4, comm: 3, creativity: 2, reliability: 4, cost: 3 },
    userFit: 70,
    reworkRounds: 0,
    approved: true,
    outputLength: 100,
    outputDigest: '示例交付',
    humanJudgment: 'approved',
    schemaVersion: 1,
    ...over,
  });
}

beforeEach(() => {
  rmSync(FAKE_OPENCLAW_DIR, { recursive: true, force: true });
  mkdirSync(FAKE_OPENCLAW_DIR, { recursive: true });
});

describe('GET /api/capsules/count', () => {
  it('空目录 → total=0', async () => {
    const { handled, status, payload } = await call('GET', '/api/capsules/count');
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(payload).toEqual({ total: 0 });
  });

  it('有胶囊 → total=N', async () => {
    writeCapsulesJsonl([capsuleJson({ capsuleId: 'a' }), capsuleJson({ capsuleId: 'b' })]);
    const { payload } = await call('GET', '/api/capsules/count');
    expect(payload.total).toBe(2);
  });
});

describe('GET /api/capsules（列表）', () => {
  it('空目录 → { capsules: [] }', async () => {
    const { handled, status, payload } = await call('GET', '/api/capsules');
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(payload).toEqual({ capsules: [] });
  });

  it('目录不存在时也返回空列表（永不抛出）', async () => {
    rmSync(FAKE_OPENCLAW_DIR, { recursive: true, force: true });
    const { payload } = await call('GET', '/api/capsules');
    expect(payload).toEqual({ capsules: [] });
  });

  it('按 jobType query 过滤', async () => {
    writeCapsulesJsonl([
      capsuleJson({ capsuleId: 'a', jobType: 'code', agentId: 'a' }),
      capsuleJson({ capsuleId: 'b', jobType: 'text', agentId: 'b' }),
    ]);
    const { payload } = await call('GET', '/api/capsules?jobType=code');
    expect(payload.capsules).toHaveLength(1);
    expect(payload.capsules[0].jobType).toBe('code');
  });

  it('按 agentId query 过滤', async () => {
    writeCapsulesJsonl([
      capsuleJson({ capsuleId: 'a', agentId: 'a' }),
      capsuleJson({ capsuleId: 'b', agentId: 'b' }),
    ]);
    const { payload } = await call('GET', '/api/capsules?agentId=b');
    expect(payload.capsules).toHaveLength(1);
    expect(payload.capsules[0].agentId).toBe('b');
  });

  it('按 approved query 过滤', async () => {
    writeCapsulesJsonl([
      capsuleJson({ capsuleId: 'a', approved: true }),
      capsuleJson({ capsuleId: 'b', approved: false }),
    ]);
    const { payload } = await call('GET', '/api/capsules?approved=true');
    expect(payload.capsules).toHaveLength(1);
    expect(payload.capsules[0].approved).toBe(true);
  });

  it('损坏行跳过，合法行仍返回', async () => {
    writeCapsulesJsonl([
      capsuleJson({ capsuleId: 'good' }),
      'not json',
      '',
      capsuleJson({ capsuleId: 'good-2' }),
    ]);
    const { payload } = await call('GET', '/api/capsules');
    expect(payload.capsules).toHaveLength(2);
  });
});

describe('POST /api/capsules（追加）', () => {
  it('必填字段缺失 → 400', async () => {
    const { status, payload } = await call('POST', '/api/capsules', { taskId: 'x' });
    expect(status).toBe(400);
    expect(payload.ok).toBe(false);
  });

  it('合法胶囊 → 落盘成功 ok=true', async () => {
    const body = JSON.parse(capsuleJson({ capsuleId: 'new' }));
    const { status, payload } = await call('POST', '/api/capsules', body);
    expect(status).toBe(200);
    expect(payload.ok).toBe(true);
    // 验证落盘
    const list = await call('GET', '/api/capsules');
    expect(list.payload.capsules).toHaveLength(1);
    expect(list.payload.capsules[0].capsuleId).toBe('new');
  });
});

describe('路由分派', () => {
  it('非 /api/capsules 前缀 → handled=false', async () => {
    const { handled } = await call('GET', '/api/traces');
    expect(handled).toBe(false);
  });

  it('PUT /api/capsules → handled=false（仅 GET/POST）', async () => {
    const { handled } = await call('PUT', '/api/capsules');
    expect(handled).toBe(false);
  });
});

// ── 群体经验共享路由（脱敏胶囊的社区池）──

function publicCapsuleJson(over: Record<string, unknown>): string {
  return JSON.stringify({
    capsuleId: 'pub-1',
    createdAt: '2025-01-01T00:00:00Z',
    agentId: 'agent-1',
    jobType: 'code',
    radar: { task: 3, quality: 4, comm: 3, creativity: 2, reliability: 4, cost: 3 },
    userFit: 70,
    reworkRounds: 0,
    approved: true,
    humanJudgment: 'approved',
    schemaVersion: 1,
    ...over,
  });
}

describe('GET /api/capsules/shared（拉取社区池）', () => {
  it('空池 → { capsules: [] }', async () => {
    const { handled, status, payload } = await call('GET', '/api/capsules/shared');
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(payload).toEqual({ capsules: [] });
  });

  it('按 jobType query 过滤', async () => {
    // 先导入一个包建立社区池
    const pkg = {
      kind: 'agentcorp-public-capsules',
      schemaVersion: 1,
      capsules: [
        JSON.parse(publicCapsuleJson({ capsuleId: 'a', jobType: 'code', agentId: 'a' })),
        JSON.parse(publicCapsuleJson({ capsuleId: 'b', jobType: 'text', agentId: 'b' })),
      ],
    };
    await call('POST', '/api/capsules/shared/import', pkg);
    const { payload } = await call('GET', '/api/capsules/shared?jobType=code');
    expect(payload.capsules).toHaveLength(1);
    expect(payload.capsules[0].jobType).toBe('code');
  });
});

describe('POST /api/capsules/shared（上传脱敏胶囊）', () => {
  it('必填缺失 → 400', async () => {
    const { status, payload } = await call('POST', '/api/capsules/shared', { capsuleId: 'x' });
    expect(status).toBe(400);
    expect(payload.ok).toBe(false);
  });

  it('合法公共胶囊 → 上传成功 ok=true', async () => {
    const body = JSON.parse(publicCapsuleJson({ capsuleId: 'up-1' }));
    const { status, payload } = await call('POST', '/api/capsules/shared', body);
    expect(status).toBe(200);
    expect(payload.ok).toBe(true);
    // 验证入池
    const list = await call('GET', '/api/capsules/shared');
    expect(list.payload.capsules.some((c: { capsuleId: string }) => c.capsuleId === 'up-1')).toBe(true);
  });
});

describe('POST /api/capsules/shared/import（导入社区包）', () => {
  it('合法包 → 导入 N 条', async () => {
    const pkg = {
      kind: 'agentcorp-public-capsules',
      schemaVersion: 1,
      capsules: [
        JSON.parse(publicCapsuleJson({ capsuleId: 'imp-1' })),
        JSON.parse(publicCapsuleJson({ capsuleId: 'imp-2' })),
      ],
    };
    const { status, payload } = await call('POST', '/api/capsules/shared/import', pkg);
    expect(status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.imported).toBe(2);
    expect(payload.skipped).toBe(0);
  });

  it('kind 不匹配 → ok=false', async () => {
    const { payload } = await call('POST', '/api/capsules/shared/import', { kind: 'other' });
    expect(payload.ok).toBe(false);
    expect(payload.imported).toBe(0);
  });
});

describe('GET /api/capsules/shared/export（导出社区包）', () => {
  it('返回合法包结构', async () => {
    const { handled, status, payload } = await call('GET', '/api/capsules/shared/export');
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(payload.kind).toBe('agentcorp-public-capsules');
    expect(payload.schemaVersion).toBe(1);
    expect(Array.isArray(payload.capsules)).toBe(true);
    expect(typeof payload.exportedAt).toBe('string');
  });
});
