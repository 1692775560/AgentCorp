/**
 * tests/unit/team-runtime-signature.test.ts
 *
 * useTeamRuntime 轮询去重签名（runtimeSessionsSignature）单测：
 * - 同内容重新拉取（JSON 重新解析、引用全换）签名不变 → 跳过 setState，TeamMap 不重渲染。
 * - 状态翻转 / updatedAt 变化 / history 追加 / 列表增删时签名变化 → 正常下发新 state。
 *
 * 背景：该 hook 每 3s 拉 /api/sessions/subagents（含完整 history），
 * 旧实现无条件 setState 全新对象，TeamMap 每轮整页重渲染。
 * 运行：pnpm vitest run tests/unit/team-runtime-signature.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  runtimeSessionsSignature,
  teamRuntimePollDelayMs,
  type RuntimeSessionSummary,
} from '@/hooks/use-team-runtime';

function makeSession(id: string, overrides: Partial<RuntimeSessionSummary> = {}): RuntimeSessionSummary {
  return {
    id,
    parentSessionKey: 'agent:a1:main',
    sessionKey: `agent:a1:sub:${id}`,
    status: 'running',
    prompt: '做点事',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    history: [{ role: 'user', content: '做点事', timestamp: 1 }],
    ...overrides,
  };
}

describe('runtimeSessionsSignature', () => {
  it('同内容重新解析（引用全换）签名保持不变', () => {
    const a = [makeSession('s1'), makeSession('s2', { status: 'blocked' })];
    const b = JSON.parse(JSON.stringify(a)) as RuntimeSessionSummary[];

    expect(runtimeSessionsSignature(a)).toBe(runtimeSessionsSignature(b));
  });

  it('状态翻转 / updatedAt 变化时签名变化', () => {
    const base = [makeSession('s1')];
    const sig = runtimeSessionsSignature(base);

    expect(runtimeSessionsSignature([makeSession('s1', { status: 'completed' })])).not.toBe(sig);
    expect(
      runtimeSessionsSignature([makeSession('s1', { updatedAt: '2026-08-01T00:01:00.000Z' })]),
    ).not.toBe(sig);
  });

  it('history 追加消息时签名变化（流式进行中的会话能正常刷新）', () => {
    const base = [makeSession('s1')];
    const appended = [
      makeSession('s1', {
        history: [
          { role: 'user', content: '做点事', timestamp: 1 },
          { role: 'assistant', content: '好了', timestamp: 2 },
        ],
      }),
    ];

    expect(runtimeSessionsSignature(appended)).not.toBe(runtimeSessionsSignature(base));
  });

  it('末条消息时间戳变化（同长度原地更新）也能被识别', () => {
    const base = [makeSession('s1')];
    const updated = [
      makeSession('s1', { history: [{ role: 'user', content: '做点事', timestamp: 9 }] }),
    ];

    expect(runtimeSessionsSignature(updated)).not.toBe(runtimeSessionsSignature(base));
  });

  it('会话增删时签名变化', () => {
    const one = [makeSession('s1')];
    const two = [makeSession('s1'), makeSession('s2')];

    expect(runtimeSessionsSignature(two)).not.toBe(runtimeSessionsSignature(one));
    expect(runtimeSessionsSignature([])).not.toBe(runtimeSessionsSignature(one));
  });
});

describe('teamRuntimePollDelayMs 失败退避', () => {
  it('无失败 → 基础间隔 3s', () => {
    expect(teamRuntimePollDelayMs(0)).toBe(3000);
    expect(teamRuntimePollDelayMs(-1)).toBe(3000);
  });

  it('连续失败指数退避：3s → 6s → 12s → 24s', () => {
    expect(teamRuntimePollDelayMs(1)).toBe(3000);
    expect(teamRuntimePollDelayMs(2)).toBe(6000);
    expect(teamRuntimePollDelayMs(3)).toBe(12000);
    expect(teamRuntimePollDelayMs(4)).toBe(24000);
  });

  it('退避封顶 30s 不无限增长', () => {
    expect(teamRuntimePollDelayMs(5)).toBe(30000);
    expect(teamRuntimePollDelayMs(20)).toBe(30000);
  });
});
