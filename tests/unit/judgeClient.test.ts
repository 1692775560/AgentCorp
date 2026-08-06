/**
 * tests/unit/judgeClient.test.ts
 *
 * 裁判客户端单测（T07）。重点验证离线回退 fallbackMock（不触达网络 / Host API）：
 *  - 产出与真实裁判同构的 SSE 事件流：radar_update×6 + verdict + done
 *  - 字段名严格对齐 judgeClient.parseBlock 解析契约
 *    （radar_update: dim/score/confidence/evidence；verdict: verdict/user_fit/evidence_trace/confidence；done: evaluation_id）
 *  - radar 分数 ∈ [0,5]；verdict ∈ {MVP,OBSERVE,FIRED}；user_fit ∈ [0,100]
 *  - 同输入 → 同输出（确定性，可复现）
 *  - evaluate() 在 fetch 失败时回退 fallbackMock（此处直接测 fallbackMock，并验证未发起网络调用）
 *
 * 隔离：mock '@/lib/api-client' 使 fallbackMock 路径完全离线。运行：pnpm test
 */
import { describe, it, expect, vi } from 'vitest';

// 让 fallbackMock 路径完全离线：api-client 的 invokeIpc 不应被调用
vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(async () => ''),
}));

import { fallbackMock } from '@/services/judgeClient';
import { invokeIpc } from '@/lib/api-client';
import type { JudgeRunInput } from '@/services/judgeClient';

async function collect(input: JudgeRunInput): Promise<any[]> {
  const out: any[] = [];
  for await (const ev of fallbackMock(input)) out.push(ev);
  return out;
}

function makeInput(usageCost: number): JudgeRunInput {
  return {
    agentId: 'agent-jc-01',
    agentName: 'JC',
    task: { title: 't', description: 'd', weight: 1 },
    transcript: 'user: hi\nagent: done',
    usage: [
      {
        timestamp: '2025-01-01T00:00:00Z',
        sessionId: 'sess-1',
        agentId: 'agent-jc-01',
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        costUsd: usageCost,
      },
    ],
  };
}

const DIMS = ['task', 'quality', 'comm', 'creativity', 'reliability', 'cost'];

describe('judgeClient.fallbackMock', () => {
  it('事件序列：radar_update×6 + narration×4 + verdict + done', async () => {
    const events = await collect(makeInput(0.2));
    expect(events.filter((e) => e.type === 'radar_update')).toHaveLength(6);
    expect(events.filter((e) => e.type === 'verdict')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    // 语音闭环：3 句讲解 + 1 条 is_final 终止帧
    const narrations = events.filter((e) => e.type === 'narration');
    expect(narrations).toHaveLength(4);
    expect(narrations[narrations.length - 1].is_final).toBe(true);
    expect(narrations[0].delta).toContain('六维评估已完成');
  });

  it('字段契约与 judgeClient.parseBlock 解析对齐', async () => {
    const events = await collect(makeInput(0.2));
    const radar = events.filter((e) => e.type === 'radar_update');
    const dims = radar.map((e: any) => e.dim);
    expect(new Set(dims)).toEqual(new Set(DIMS));

    for (const e of radar) {
      expect(Object.keys(e).sort()).toEqual(['confidence', 'dim', 'evidence', 'score', 'type']);
      expect(e.score).toBeGreaterThanOrEqual(0);
      expect(e.score).toBeLessThanOrEqual(5);
      expect(typeof e.confidence).toBe('number');
    }

    const v = events.find((e: any) => e.type === 'verdict') as any;
    expect(Object.keys(v).sort()).toEqual(['confidence', 'evidence_trace', 'type', 'user_fit', 'verdict']);
    expect(['MVP', 'OBSERVE', 'FIRED']).toContain(v.verdict);
    expect(v.user_fit).toBeGreaterThanOrEqual(0);
    expect(v.user_fit).toBeLessThanOrEqual(100);
    expect(Array.isArray(v.evidence_trace)).toBe(true);

    const d = events.find((e: any) => e.type === 'done') as any;
    expect(d.evaluation_id).toMatch(/^mock-/);

    // narration 字段契约（对齐 model-service NarrationEvent）
    for (const e of events.filter((ev) => ev.type === 'narration') as any[]) {
      expect(Object.keys(e).sort()).toEqual(['delta', 'is_final', 'type']);
      expect(typeof e.delta).toBe('string');
      expect(typeof e.is_final).toBe('boolean');
    }
  });

  it('完全离线：fallbackMock 不发起任何网络调用', async () => {
    await collect(makeInput(0.2));
    expect(invokeIpc).not.toHaveBeenCalled();
  });

  it('确定性：同输入 → 同 radar 分数', async () => {
    const a = await collect(makeInput(0.42));
    const b = await collect(makeInput(0.42));
    const scoresA = a.filter((e: any) => e.type === 'radar_update').map((e: any) => e.score);
    const scoresB = b.filter((e: any) => e.type === 'radar_update').map((e: any) => e.score);
    expect(scoresA).toEqual(scoresB);
  });

  it('usage 成本越高 → cost 维越低（裁剪到 [0,5]）', async () => {
    const low = await collect(makeInput(0.0));
    const high = await collect(makeInput(2.0));
    const costLow = (low.find((e: any) => e.type === 'radar_update' && e.dim === 'cost') as any).score;
    const costHigh = (high.find((e: any) => e.type === 'radar_update' && e.dim === 'cost') as any).score;
    expect(costHigh).toBeLessThan(costLow);
    expect(costHigh).toBeGreaterThanOrEqual(0);
    expect(costLow).toBeLessThanOrEqual(5);
  });
});
