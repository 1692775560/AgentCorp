import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aggregateRadars, majorityVerdict, judgeChatEnsemble } from '@/services/judgeEnsemble';
import { judgeChat } from '@/services/judgeClient';
import type { RadarScore, Verdict } from '@/types/evaluation';

vi.mock('@/services/judgeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/judgeClient')>();
  return {
    ...actual,
    judgeChat: vi.fn(),
  };
});

describe('aggregateRadars', () => {
  it('逐维平均', () => {
    const a: RadarScore = {
      task: 2,
      quality: 4,
      comm: 0,
      creativity: 0,
      reliability: 0,
      cost: 0,
    };
    const b: RadarScore = {
      task: 4,
      quality: 2,
      comm: 0,
      creativity: 0,
      reliability: 0,
      cost: 0,
    };
    const m = aggregateRadars([a, b]);
    expect(m.task).toBe(3);
    expect(m.quality).toBe(3);
  });

  it('空输入 => 全零雷达', () => {
    expect(aggregateRadars([]).task).toBe(0);
  });

  it('过滤非对象元素（防御式）', () => {
    const a: RadarScore = {
      task: 4,
      quality: 4,
      comm: 4,
      creativity: 4,
      reliability: 4,
      cost: 4,
    };
    const m = aggregateRadars([a, null as unknown as RadarScore]);
    expect(m.task).toBe(4);
  });
});

describe('majorityVerdict', () => {
  it('取出现次数最多的判定', () => {
    expect(majorityVerdict(['MVP', 'MVP', 'OBSERVE'] as Verdict[])).toBe('MVP');
  });

  it('忽略 null', () => {
    expect(majorityVerdict([null, 'FIRED', 'FIRED'] as Verdict[])).toBe('FIRED');
  });

  it('全部 null/undefined => null', () => {
    expect(majorityVerdict([null, undefined])).toBeNull();
  });

  it('单样本直接返回', () => {
    expect(majorityVerdict(['OBSERVE'] as Verdict[])).toBe('OBSERVE');
  });
});

describe('judgeChatEnsemble 的 source 三态', () => {
  const flat: RadarScore = {
    task: 4,
    quality: 4,
    comm: 4,
    creativity: 4,
    reliability: 4,
    cost: 4,
  };
  const mocked = vi.mocked(judgeChat);

  /** 按给定来源序列依次应答 */
  const respondWith = (sources: Array<'judge' | 'degraded'>): void => {
    mocked.mockReset();
    for (const source of sources) {
      mocked.mockResolvedValueOnce({
        radar: flat,
        source,
        verdict: 'MVP',
        confidence: 0.9,
        evidence_trace: [],
      } as Awaited<ReturnType<typeof judgeChat>>);
    }
  };

  beforeEach(() => {
    mocked.mockReset();
  });

  it('全部真裁判 => judge，judgeCount = k', async () => {
    respondWith(['judge', 'judge', 'judge']);
    const r = await judgeChatEnsemble('a1', 'transcript', { k: 3 });
    expect(r?.source).toBe('judge');
    expect(r?.judgeCount).toBe(3);
  });

  it('真裁判与回退混合 => mixed（此前会误报 judge）', async () => {
    respondWith(['judge', 'degraded', 'degraded']);
    const r = await judgeChatEnsemble('a1', 'transcript', { k: 3 });
    expect(r?.source).toBe('mixed');
    expect(r?.judgeCount).toBe(1);
  });

  it('全部回退 => degraded，judgeCount = 0', async () => {
    respondWith(['degraded', 'degraded']);
    const r = await judgeChatEnsemble('a1', 'transcript', { k: 2 });
    expect(r?.source).toBe('degraded');
    expect(r?.judgeCount).toBe(0);
  });

  it('全部调用失败 => null，由调用方降级', async () => {
    mocked.mockReset();
    mocked.mockRejectedValue(new Error('judge unreachable'));
    expect(await judgeChatEnsemble('a1', 'transcript', { k: 2 })).toBeNull();
  });

  it('k 次离散度过高 → 置信下调且 biasAudit.unstable + 提示人工复核', async () => {
    mocked.mockReset();
    const base = { ...flat, source: 'judge' as const, verdict: 'MVP' as Verdict, confidence: 0.9, evidence_trace: [] };
    mocked
      .mockResolvedValueOnce({ ...base, radar: { ...flat, task: 2 } })
      .mockResolvedValueOnce({ ...base, radar: { ...flat, task: 5 } })
      .mockResolvedValueOnce({ ...base, radar: { ...flat, task: 3 } });
    const r = await judgeChatEnsemble('a1', 'transcript', { k: 3 });
    expect(r?.biasAudit?.unstable).toBe(true);
    expect(r?.biasAudit?.perDimSpread.task).toBe(3);
    // 置信从 0.9 下调到 0.8×0.9=0.72
    expect(r?.confidence).toBe(0.72);
    expect(r?.evidence_trace.some((s) => s.includes('评委离散度偏高'))).toBe(true);
  });
});
