/**
 * tests/unit/a2a-trace.test.ts
 *
 * A2A P1（委派 trace 采集进评估，a2a-integration §3.4）单测：
 * - a2a-trace.ts：schema 读写 / 派生函数 / 写失败容错（真实 fs + 临时目录）
 * - SessionRuntimeManager：spawn/steer/kill 埋点 → trace（fake gateway RPC）
 * - eval-data.collectRunData：消费 trace 后 rework≥1 / latency>0；无 trace 兜底不变
 *
 * 文件系统隔离：getOpenClawConfigDir mock 到进程级临时目录（vi.hoisted 先于模块加载）。
 *
 * 运行：pnpm test
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// 进程级临时配置目录（mock 工厂在模块加载前执行，必须 hoisted；只拼路径不触盘）
const TMP_CONFIG_DIR = vi.hoisted(
  () => `${process.env.TMPDIR ?? '/tmp'}/a2a-trace-test-${process.pid}-${Date.now()}`,
);

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => TMP_CONFIG_DIR,
}));

const TOKEN_ENTRIES = [
  {
    timestamp: '2025-01-01T00:00:00Z',
    sessionId: 'sess-eval',
    agentId: 'agent-1',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1500,
    costUsd: 0.2,
  },
  {
    timestamp: '2025-01-01T00:01:00Z',
    sessionId: 'sess-no-trace',
    agentId: 'agent-1',
    inputTokens: 800,
    outputTokens: 300,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1100,
    costUsd: 0.1,
  },
];

vi.mock('@electron/utils/token-usage', () => ({
  getRecentTokenUsageHistory: vi.fn(async () => TOKEN_ENTRIES),
}));

import {
  appendA2aTrace,
  delegatorFromSessionKey,
  deriveRootSessionId,
  getA2aTracesDir,
  loadA2aTracesForRun,
  readA2aTraces,
} from '@electron/services/evaluation/a2a-trace';
import { SessionRuntimeManager } from '@electron/services/session-runtime-manager';
import { collectRunData } from '@electron/services/evaluation/eval-data';
import type { A2aTraceRecord } from '@/types/evaluation';

const TRACES_DIR = join(TMP_CONFIG_DIR, 'a2a-traces');

beforeAll(() => {
  mkdirSync(TMP_CONFIG_DIR, { recursive: true });
});

function makeTrace(overrides: Partial<A2aTraceRecord>): A2aTraceRecord {
  return {
    trace_id: 'trace-1',
    task_id: 'task-1',
    parent_task_id: null,
    delegator: 'agent:leader',
    delegatee: 'agent:worker',
    round: 1,
    kind: 'message',
    state: 'submitted',
    rework_of: null,
    channel: 'internal-rpc',
    sent_at: '2025-01-01T00:00:00.000Z',
    completed_at: null,
    summary: 'do X',
    session_key: 'agent:leader:sess-eval:subagent:task-1',
    root_session_id: 'sess-eval',
    trigger: 'spawn',
    ...overrides,
  };
}

afterAll(() => {
  rmSync(TMP_CONFIG_DIR, { recursive: true, force: true });
});

describe('a2a-trace schema 读写', () => {
  it('getA2aTracesDir 指向 <configDir>/a2a-traces', () => {
    expect(getA2aTracesDir()).toBe(TRACES_DIR);
  });

  it('deriveRootSessionId / delegatorFromSessionKey 解析各种 sessionKey', () => {
    expect(deriveRootSessionId('agent:leader:sess-1')).toBe('sess-1');
    expect(deriveRootSessionId('agent:leader:sess-1:subagent:abc')).toBe('sess-1');
    expect(deriveRootSessionId('agent:leader:sess-1:subagent:a:subagent:b')).toBe('sess-1');
    expect(deriveRootSessionId('')).toBe('');
    expect(deriveRootSessionId('bare-key')).toBe('bare-key');
    expect(delegatorFromSessionKey('agent:leader:sess-1')).toBe('agent:leader');
    expect(delegatorFromSessionKey('agent:leader:sess-1:subagent:abc')).toBe('agent:leader');
    expect(delegatorFromSessionKey('weird')).toBe('unknown');
  });

  it('appendA2aTrace 自动建目录、JSONL 追加；readA2aTraces 按 sent_at 升序回读', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2a-trace-rw-'));
    const later = makeTrace({ trace_id: 't-2', sent_at: '2025-01-01T00:02:00.000Z', round: 2, trigger: 'steer', rework_of: 't-1' });
    const earlier = makeTrace({ trace_id: 't-1' });
    expect(await appendA2aTrace(later, dir)).toBe(true);
    expect(await appendA2aTrace(earlier, dir)).toBe(true);

    // 写入一行坏 JSON：读端应跳过而不是抛错
    writeFileSync(join(dir, 'sess-eval.jsonl'), '{"broken"\n', { flag: 'a' });

    const traces = await readA2aTraces('sess-eval', dir);
    expect(traces.map((t) => t.trace_id)).toEqual(['t-1', 't-2']);
    expect(traces[1].rework_of).toBe('t-1');
    expect(traces[1].trigger).toBe('steer');
    rmSync(dir, { recursive: true, force: true });
  });

  it('读取缺失文件返回 []；写入不可建目录返回 false 而不抛出', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2a-trace-err-'));
    expect(await readA2aTraces('no-such', dir)).toEqual([]);
    // 在目标位置放一个普通文件，mkdir(recursive) 必失败
    const blocker = join(dir, 'blocked');
    writeFileSync(blocker, 'not a dir');
    expect(await appendA2aTrace(makeTrace({}), join(blocker, 'sub'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('SessionRuntimeManager 委派埋点 → trace', () => {
  function fakeGateway() {
    return {
      rpc: vi.fn(async (method: string) => {
        if (method === 'chat.send') return { runId: 'run-1' };
        if (method === 'sessions.list') return { sessions: [] };
        if (method === 'chat.history') return { messages: [] };
        return {};
      }),
    };
  }

  it('spawn + steer + kill 各写一条 trace，rework 链与轮次正确，委派主流程不受影响', async () => {
    const manager = new SessionRuntimeManager(fakeGateway());
    const spawned = await manager.spawn({
      parentSessionKey: 'agent:leader:sess-rt',
      prompt: '实现登录页',
      agentName: 'worker',
    });
    expect(spawned.status).toBe('running');

    const steered = await manager.steer(spawned.id, '登录页要支持 OAuth，返工');
    expect(steered?.id).toBe(spawned.id);

    const killed = await manager.kill(spawned.id);
    expect(killed?.status).toBe('killed');

    const traces = await readA2aTraces('sess-rt');
    expect(traces).toHaveLength(3);
    const [spawnTrace, steerTrace, killTrace] = traces;

    expect(spawnTrace.trigger).toBe('spawn');
    expect(spawnTrace.kind).toBe('message');
    expect(spawnTrace.state).toBe('submitted');
    expect(spawnTrace.round).toBe(1);
    expect(spawnTrace.rework_of).toBeNull();
    expect(spawnTrace.delegator).toBe('agent:leader');
    expect(spawnTrace.delegatee).toBe('agent:worker');
    expect(spawnTrace.task_id).toBe(spawned.id);
    expect(spawnTrace.root_session_id).toBe('sess-rt');
    expect(spawnTrace.session_key).toBe(spawned.sessionKey);
    expect(spawnTrace.channel).toBe('internal-rpc');
    expect(spawnTrace.summary).toBe('实现登录页');

    expect(steerTrace.trigger).toBe('steer');
    expect(steerTrace.round).toBe(2);
    expect(steerTrace.rework_of).toBe(spawnTrace.trace_id);
    expect(steerTrace.summary).toContain('返工');

    expect(killTrace.trigger).toBe('kill');
    expect(killTrace.kind).toBe('status');
    expect(killTrace.state).toBe('canceled');
    expect(killTrace.completed_at).not.toBeNull();
  });

  it('trace 落盘失败时 spawn/steer/kill 仍正常返回（旁路容错）', async () => {
    // 用一个普通文件占住 a2a-traces 路径，使 mkdir 必失败
    rmSync(TRACES_DIR, { recursive: true, force: true });
    writeFileSync(TRACES_DIR, 'blocked');
    try {
      const manager = new SessionRuntimeManager(fakeGateway());
      const spawned = await manager.spawn({
        parentSessionKey: 'agent:leader:sess-blocked',
        prompt: 'task',
        agentName: 'worker',
      });
      expect(spawned.id).toBeTruthy();
      await expect(manager.steer(spawned.id, 'redo')).resolves.not.toBeNull();
      await expect(manager.kill(spawned.id)).resolves.not.toBeNull();
    } finally {
      rmSync(TRACES_DIR, { force: true });
    }
  });
});

describe('collectRunData 消费 A2A trace', () => {
  it('有 trace 时 rework / escalations / latency_ms 由 trace 客观计算', async () => {
    const t0 = '2025-01-01T00:00:00.000Z';
    const t1 = '2025-01-01T00:01:05.000Z'; // +65s
    await appendA2aTrace(makeTrace({ trace_id: 'ev-spawn', sent_at: t0 }));
    await appendA2aTrace(makeTrace({
      trace_id: 'ev-steer',
      round: 2,
      trigger: 'steer',
      rework_of: 'ev-spawn',
      sent_at: t1,
    }));
    await appendA2aTrace(makeTrace({
      trace_id: 'ev-help',
      kind: 'status',
      state: 'input-required',
      sent_at: t1,
    }));

    const data = await collectRunData('agent-1', 'sess-eval');
    expect(data.traces).toHaveLength(3);
    expect(data.events).toHaveLength(1);
    const event = data.events[0];
    expect(event.rework).toBe(1);
    expect(event.rework).toBeGreaterThanOrEqual(1);
    expect(event.latency_ms).toBe(65_000);
    expect(event.latency_ms).toBeGreaterThan(0);
    expect(event.escalations).toBe(1);
    expect(event.human_interventions).toBe(1);
    expect(event.first_try).toBe(false);
    expect(event.agent_id).toBe('agent-1');
    expect(event.task_id).toBe('sess-eval');
    // trace_id 可回放：返回包带原始 trace 记录
    expect(data.traces.map((t) => t.trace_id)).toContain('ev-steer');
  });

  it('无 trace 时保持既有兜底行为不变（usage 派生最小遥测）', async () => {
    const data = await collectRunData('agent-1', 'sess-no-trace');
    expect(data.traces).toEqual([]);
    expect(data.events.length).toBeGreaterThan(0);
    for (const e of data.events) {
      expect(e.rework).toBe(0);
      expect(e.escalations).toBe(0);
      expect(e.human_interventions).toBe(0);
      expect(e.latency_ms).toBe(0);
      expect(e.first_try).toBe(true);
      expect(e.success).toBe(true);
    }
  });

  it('loadA2aTracesForRun 可按 delegatee agentId 关联（评估 worker 路径）', async () => {
    const traces = await loadA2aTracesForRun('worker', 'sess-unrelated');
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.every((t) => t.delegatee === 'agent:worker')).toBe(true);
  });
});
