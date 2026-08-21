/**
 * tests/unit/convergence-store.test.ts
 *
 * convergenceStore 状态机单测（mock convergenceService 网络层，不触 Host API）：
 * - initTrace 建轨迹 + 预热锚点库；
 * - recordTurn 同轮号替换（幂等重记，不叠加）；
 * - pinCandidate → commitPin：锚点库按 id 去重合并、trace 写回 anchor_candidate_id、
 *   explicitPin 清空；网络失败仍保留内存态；
 * - setAnchor：无活跃 trace / 候选不在候选集 → 静默 false；
 *   在候选集 → true 且与 explicit_pin 互斥（explicitPin 清空）；
 * - computeScore：服务端对拍失败时保本地镜像分（不抛、不清空）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TurnState, CandidateEmbedding, HumanAnchor } from '@/types/convergence';

const serviceMocks = vi.hoisted(() => ({
  cacheTrace: vi.fn(async () => undefined),
  readCachedTrace: vi.fn(async () => null),
  cacheAnchor: vi.fn(async () => undefined),
  postTrace: vi.fn(async () => ({ run_id: 'run-1' })),
  postScore: vi.fn(async () => ({ run_id: 'run-1', score: 0.9 })),
  getAnchors: vi.fn(async () => [] as HumanAnchor[]),
  postAnchor: vi.fn(async () => ({ ok: true, anchor_id: 'a' })),
}));

vi.mock('@/services/convergenceService', () => ({
  convergenceService: serviceMocks,
}));

import { useConvergenceStore } from '@/stores/convergenceStore';

const store = () => useConvergenceStore.getState();

function makeCandidate(id: string): CandidateEmbedding {
  return {
    candidate_id: id,
    turn: 1,
    summary_text: `候选 ${id}`,
    embedding: [0.1, 0.2],
    job_type: 'code',
  };
}

function makeTurn(turn: number, candidates: CandidateEmbedding[]): TurnState {
  return { turn, candidates, belief_embedding: [0.1, 0.2] };
}

function init() {
  store().initTrace({ runId: 'run-1', agentId: 'agent-1', createdBy: 'boss' });
}

describe('convergenceStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.getAnchors.mockResolvedValue([]);
    useConvergenceStore.setState({
      trace: null,
      score: null,
      anchors: [],
      explicitPin: null,
    });
  });

  it('initTrace 建空轨迹并预热锚点库', async () => {
    init();
    const { trace, score, explicitPin } = store();
    expect(trace?.run_id).toBe('run-1');
    expect(trace?.turns).toEqual([]);
    expect(score).toBeNull();
    expect(explicitPin).toBeNull();
    expect(serviceMocks.cacheTrace).toHaveBeenCalled();
    await vi.waitFor(() => {
      if (!serviceMocks.getAnchors.mock.calls.length) throw new Error('not warmed');
    });
    expect(serviceMocks.getAnchors).toHaveBeenCalledWith('boss');
  });

  it('recordTurn 同轮号替换（重记幂等，turns 不叠加）', () => {
    init();
    store().recordTurn(makeTurn(1, [makeCandidate('c1')]));
    store().recordTurn(makeTurn(1, [makeCandidate('c1'), makeCandidate('c2')]));
    store().recordTurn(makeTurn(2, [makeCandidate('c3')]));
    const turns = store().trace!.turns;
    expect(turns).toHaveLength(2);
    expect(turns.find((t) => t.turn === 1)!.candidates).toHaveLength(2);
  });

  it('pinCandidate + commitPin：锚点去重合并、写回 trace、清 explicitPin', async () => {
    init();
    const candidate = makeCandidate('c1');
    store().pinCandidate(1, candidate);
    expect(store().explicitPin?.candidate_id).toBe('c1');

    await store().commitPin();
    const { anchors, trace, explicitPin } = store();
    expect(serviceMocks.postAnchor).toHaveBeenCalled();
    expect(anchors).toHaveLength(1);
    expect(anchors[0].candidate_id).toBe('c1');
    expect(trace?.anchor_candidate_id).toBe('c1');
    expect(explicitPin).toBeNull();

    // 同候选再次 commit：按 anchor_id 去重，不翻倍
    store().pinCandidate(2, candidate);
    await store().commitPin();
    expect(store().anchors).toHaveLength(1);
  });

  it('commitPin 网络失败：内存态保留（锚点照入、explicitPin 清空）', async () => {
    init();
    serviceMocks.postAnchor.mockRejectedValueOnce(new Error('network down'));
    store().pinCandidate(1, makeCandidate('c1'));
    await store().commitPin();
    expect(store().anchors).toHaveLength(1);
    expect(store().explicitPin).toBeNull();
  });

  it('setAnchor：无活跃 trace → false（静默 noop）', async () => {
    expect(await store().setAnchor('c1')).toBe(false);
    expect(serviceMocks.postAnchor).not.toHaveBeenCalled();
  });

  it('setAnchor：候选不在 trace 候选集 → false', async () => {
    init();
    store().recordTurn(makeTurn(1, [makeCandidate('c1')]));
    expect(await store().setAnchor('c-other')).toBe(false);
    expect(serviceMocks.postAnchor).not.toHaveBeenCalled();
  });

  it('setAnchor：候选在集中 → true，与 explicit_pin 互斥', async () => {
    init();
    store().recordTurn(makeTurn(1, [makeCandidate('c1'), makeCandidate('c2')]));
    store().pinCandidate(1, makeCandidate('c2'));
    expect(store().explicitPin).not.toBeNull();

    expect(await store().setAnchor('c1')).toBe(true);
    const { anchors, trace, explicitPin } = store();
    expect(trace?.anchor_candidate_id).toBe('c1');
    expect(explicitPin).toBeNull(); // 拖拽源覆盖显式 pin（互斥合并）
    expect(anchors.some((a) => a.candidate_id === 'c1')).toBe(true);
  });

  it('computeScore：服务端对拍失败 → 保本地镜像分（不抛）', async () => {
    init();
    store().recordTurn(makeTurn(1, [makeCandidate('c1')]));
    serviceMocks.postScore.mockRejectedValueOnce(new Error('503'));
    const score = await store().computeScore();
    expect(score).not.toBeNull();
    expect(store().score).toEqual(score);
  });

  it('computeScore：无轨迹/零轮 → null', async () => {
    expect(await store().computeScore()).toBeNull();
  });
});
