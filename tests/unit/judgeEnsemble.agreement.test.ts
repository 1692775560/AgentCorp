/**
 * judgeEnsemble · 跨评委一致性 α 的矩阵朝向回归测试。
 *
 * 回归目标：krippendorffAlphaMulti 契约是 rows=候选(6 维)、cols=评委(k 次运行)。
 * 之前 judgeEnsemble 把矩阵传反（行=运行、列=维），导致「稳定 agent」算出负 α，
 * 误触发「一致性低→人工复核」。本测试用 mock 裁判锁定正确朝向：
 *   - 稳定 agent（k 次雷达完全一致）→ agreementAlpha ≈ 1（≥0.67）
 *   - 高离散 agent（k 次雷达差异大）→ agreementAlpha 明显更低
 * 若有人把 judgeEnsemble 里的两层 .map 重新转置，此测试会立刻变红。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RadarScore } from '@/types/evaluation';

const STABLE: RadarScore = {
  task: 4,
  quality: 4,
  comm: 4,
  creativity: 4,
  reliability: 4,
  cost: 3,
};

const DIVERGENT: RadarScore[] = [
  { task: 5, quality: 1, comm: 5, creativity: 1, reliability: 5, cost: 1 },
  { task: 1, quality: 5, comm: 1, creativity: 5, reliability: 1, cost: 5 },
  { task: 3, quality: 3, comm: 3, creativity: 3, reliability: 3, cost: 3 },
  { task: 5, quality: 5, comm: 1, creativity: 1, reliability: 5, cost: 1 },
  { task: 1, quality: 1, comm: 5, creativity: 5, reliability: 1, cost: 5 },
];

vi.mock('@/services/judgeClient', () => ({
  auditJudgeBias: vi.fn(() => ({ unstable: false, maxSpread: 0 })),
  judgeChat: vi.fn(),
}));

import { judgeChatEnsemble } from '@/services/judgeEnsemble';
import { judgeChat } from '@/services/judgeClient';

describe('judgeEnsemble · agreementAlpha orientation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('稳定 agent（k 次雷达完全一致）→ agreementAlpha ≈ 1（≥0.67）', async () => {
    vi.mocked(judgeChat).mockImplementation(async () => ({
      radar: STABLE,
      verdict: 'MVP',
      confidence: 0.9,
      source: 'judge',
      evidence_trace: [],
    }));

    const res = await judgeChatEnsemble('agent-stable', 'transcript', { k: 5 });
    expect(res).not.toBeNull();
    expect(res!.agreementAlpha).not.toBeNull();
    // 稳定 agent 必须高一致；之前传反会算出负 α
    expect(res!.agreementAlpha!).toBeGreaterThanOrEqual(0.67);
    expect(res!.agreementAlpha!).toBeCloseTo(1, 1);
  });

  it('高离散 agent（k 次雷达差异大）→ agreementAlpha 明显更低', async () => {
    let i = 0;
    vi.mocked(judgeChat).mockImplementation(async () => ({
      radar: DIVERGENT[i++ % DIVERGENT.length],
      verdict: 'OBSERVE',
      confidence: 0.6,
      source: 'judge',
      evidence_trace: [],
    }));

    const res = await judgeChatEnsemble('agent-divergent', 'transcript', { k: 5 });
    expect(res).not.toBeNull();
    expect(res!.agreementAlpha).not.toBeNull();
    // 离散 agent 一致性应显著低于稳定 agent
    expect(res!.agreementAlpha!).toBeLessThan(0.67);
  });
});
