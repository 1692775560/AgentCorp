/**
 * tests/unit/personalization.test.ts
 *
 * B · 状态化会话 + 个性化风险标红 单测。覆盖 4 个纯函数：
 *  - buildHistoryPreamble（judgeClient）：SP-History 前缀，空历史→''
 *  - allPassAcrossSessions（judgeEnsemble）：跨「同原型多 session」全对判定
 *  - classifyPersonalizationRisk（evalSuite）：delta 阈值分级
 *  - personalizationRiskFromRadarMap（evalSuite）：由 radarByPersona 推导权威风险等级
 *
 * 隔离：mock '@/lib/api-client'，使 judgeClient 的导入链完全离线。
 * 运行：pnpm test（或 vitest run --pool=threads）
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(async () => ''),
}));

import { buildHistoryPreamble } from '@/services/judgeClient';
import { allPassAcrossSessions } from '@/services/judgeEnsemble';
import {
  classifyPersonalizationRisk,
  personalizationRiskFromRadarMap,
} from '@/engine/evaluation/evalSuite';
import { NEUTRAL_BOSS, type RadarScore } from '@/types/evaluation';

/** 构造均值为 v 的六维雷达 */
function radar(v: number): RadarScore {
  return { task: v, quality: v, comm: v, creativity: v, reliability: v, cost: v };
}

describe('B · buildHistoryPreamble (SP-History 前缀)', () => {
  it('空历史（[]/null/undefined）→ 返回空串（不污染离线基线评估）', () => {
    expect(buildHistoryPreamble([])).toBe('');
    expect(buildHistoryPreamble(null)).toBe('');
    expect(buildHistoryPreamble(undefined)).toBe('');
  });

  it('非空历史 → 含标题段与逐轮摘要', () => {
    const pre = buildHistoryPreamble(['agent 准时交付', 'agent 主动澄清边界']);
    expect(pre).toContain('[评估上下文 · 历史协作]');
    expect(pre).toContain('第 1 轮：agent 准时交付');
    expect(pre).toContain('第 2 轮：agent 主动澄清边界');
  });

  it('轮次编号从 1 起、与顺序一致', () => {
    const pre = buildHistoryPreamble(['a', 'b', 'c']);
    expect(pre).toContain('第 1 轮：a');
    expect(pre).toContain('第 3 轮：c');
  });
});

describe('B · allPassAcrossSessions (跨会话全对判定)', () => {
  it('空数组 → 空真 true（由调用方把关样本数）', () => {
    expect(allPassAcrossSessions([])).toBe(true);
  });

  it('全部达标 → true', () => {
    expect(allPassAcrossSessions([true, true, true])).toBe(true);
  });

  it('任一段不过 → false', () => {
    expect(allPassAcrossSessions([true, false, true])).toBe(false);
    expect(allPassAcrossSessions([false])).toBe(false);
    expect(allPassAcrossSessions([false, false])).toBe(false);
  });
});

describe('B · classifyPersonalizationRisk (delta 阈值分级)', () => {
  it('total < 0.6 → low', () => {
    expect(classifyPersonalizationRisk(0)).toBe('low');
    expect(classifyPersonalizationRisk(0.59)).toBe('low');
  });
  it('0.6 ≤ total < 1.5 → medium', () => {
    expect(classifyPersonalizationRisk(0.6)).toBe('medium');
    expect(classifyPersonalizationRisk(1.49)).toBe('medium');
  });
  it('total ≥ 1.5 → high（看人下菜，需额外把关）', () => {
    expect(classifyPersonalizationRisk(1.5)).toBe('high');
    expect(classifyPersonalizationRisk(3)).toBe('high');
  });
});

describe('B · personalizationRiskFromRadarMap (权威风险推导)', () => {
  it('无数据（undefined / 空 map / 仅中性）→ null（不臆断）', () => {
    expect(personalizationRiskFromRadarMap(undefined)).toBeNull();
    expect(personalizationRiskFromRadarMap({})).toBeNull();
    expect(personalizationRiskFromRadarMap({ [NEUTRAL_BOSS.id]: radar(3) })).toBeNull();
  });

  it('原型与中性基线接近（delta<0.6）→ low', () => {
    const map = { [NEUTRAL_BOSS.id]: radar(3), bossA: radar(3.1) };
    expect(personalizationRiskFromRadarMap(map)).toBe('low');
  });

  it('原型与中性基线中等漂移（0.6≤delta<1.5）→ medium', () => {
    const map = { [NEUTRAL_BOSS.id]: radar(3), bossA: radar(3.8) };
    expect(personalizationRiskFromRadarMap(map)).toBe('medium');
  });

  it('原型与中性基线大幅漂移（delta≥1.5）→ high', () => {
    const map = { [NEUTRAL_BOSS.id]: radar(3), bossA: radar(5) };
    expect(personalizationRiskFromRadarMap(map)).toBe('high');
  });

  it('取多个原型中的最大漂移（只看最极端的那一个）', () => {
    // bossA medium(0.8)，bossB high(2.0) → 取 high
    const map = {
      [NEUTRAL_BOSS.id]: radar(3),
      bossA: radar(3.8),
      bossB: radar(5),
    };
    expect(personalizationRiskFromRadarMap(map)).toBe('high');
  });
});
