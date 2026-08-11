/**
 * tests/unit/evalSuite.test.ts
 * C · 基准套件引擎单测（computePersonaSuite / personalizationDelta / fitForProfile）。
 *
 * 覆盖 Wang (2024) "Benchmark suites instead of leaderboards" 在 AgentCorp 的落地：
 *  - fitForProfile：按老板原型强调维加权的契合度（中性退化为六维均值；可靠性差者在风险老板下扣分）
 *  - personalizationDelta：|中性 − 原型| 逐维漂移；任一侧缺失 → 0
 *  - computePersonaSuite：维度×原型矩阵 + 跨原型均值 + 逐维波动 + 个性化增量（取逐原型最大漂移）
 */
import { describe, it, expect } from 'vitest';
import {
  computePersonaSuite,
  personalizationDelta,
  fitForProfile,
} from '@/engine/evaluation/evalSuite';
import { NEUTRAL_BOSS, type BossProfile, type RadarScore } from '@/types/evaluation';

const NEUTRAL_RADAR: RadarScore = {
  task: 4,
  quality: 4,
  comm: 4,
  creativity: 4,
  reliability: 4,
  cost: 4,
};
const GROWTH_RADAR: RadarScore = {
  task: 5,
  quality: 3,
  comm: 4.5,
  creativity: 4.5,
  reliability: 3,
  cost: 2,
};
const RISK_RADAR: RadarScore = {
  task: 2,
  quality: 2,
  comm: 5,
  creativity: 5,
  reliability: 2,
  cost: 4,
};

const BOSS_RISK: BossProfile = {
  id: 'boss-risk',
  name: '风险厌恶老板',
  experienceLevel: 'expert',
  riskAversion: 'high',
  communicationStyle: 'detailed',
  constraintPrefs: ['safety', 'quality'],
};

describe('fitForProfile', () => {
  it('无雷达 → null', () => {
    expect(fitForProfile(null, BOSS_RISK)).toBeNull();
  });

  it('中性原型（无强调）→ 六维均值×20', () => {
    expect(fitForProfile(NEUTRAL_RADAR, null)).toBe(80);
  });

  it('可靠性薄弱的 agent 在风险厌恶老板下契合度被压低', () => {
    const unreliable: RadarScore = {
      task: 5,
      quality: 5,
      comm: 5,
      creativity: 5,
      reliability: 1,
      cost: 1,
    };
    const neutralFit = fitForProfile(unreliable, null); // 73
    const riskFit = fitForProfile(unreliable, BOSS_RISK); // 72
    expect(riskFit).toBeLessThan(neutralFit);
  });

  it('可靠性强的 agent 在风险厌恶老板下契合度被抬高', () => {
    const reliable: RadarScore = {
      task: 3,
      quality: 3,
      comm: 3,
      creativity: 3,
      reliability: 5,
      cost: 5,
    };
    const neutralFit = fitForProfile(reliable, null); // 73
    const riskFit = fitForProfile(reliable, BOSS_RISK); // 74
    expect(riskFit).toBeGreaterThan(neutralFit);
  });
});

describe('personalizationDelta', () => {
  it('逐维绝对差与总均值（0–5）', () => {
    const { perDim, total } = personalizationDelta(NEUTRAL_RADAR, GROWTH_RADAR);
    // task 1, quality 1, comm 0.5, creativity 0.5, reliability 1, cost 2 → 总 1.0
    expect(perDim.task).toBe(1);
    expect(perDim.cost).toBe(2);
    expect(total).toBe(1.0);
  });

  it('任一侧缺失 → 全 0', () => {
    expect(personalizationDelta(null, GROWTH_RADAR).total).toBe(0);
    expect(personalizationDelta(NEUTRAL_RADAR, null).total).toBe(0);
    expect(personalizationDelta(NEUTRAL_RADAR, GROWTH_RADAR).perDim).not.toEqual({});
  });
});

describe('computePersonaSuite', () => {
  const profiles = [NEUTRAL_BOSS, { id: 'boss-growth', name: '成长型老板' } as BossProfile, BOSS_RISK];
  const radarByPersona: Record<string, RadarScore> = {
    [NEUTRAL_BOSS.id]: NEUTRAL_RADAR,
    'boss-growth': GROWTH_RADAR,
    'boss-risk': RISK_RADAR,
  };

  it('列数 = 原型数；neutral 锚点正确；全部已评估', () => {
    const suite = computePersonaSuite({ agentId: 'a1', radarByPersona, profiles });
    expect(suite.columns).toHaveLength(3);
    expect(suite.neutral).toEqual(NEUTRAL_RADAR);
    expect(suite.columns.filter((c) => c.radar).length).toBe(3);
  });

  it('跨原型逐维均值雷达', () => {
    const suite = computePersonaSuite({ agentId: 'a1', radarByPersona, profiles });
    expect(suite.meanRadar.task).toBeCloseTo(3.67, 2); // (4+5+2)/3
    expect(suite.meanRadar.quality).toBeCloseTo(3.0, 2); // (4+3+2)/3
    expect(suite.meanRadar.comm).toBeCloseTo(4.5, 2); // (4+4.5+5)/3
  });

  it('逐维波动 = max−min（task: 4,5,2 → 3）', () => {
    const suite = computePersonaSuite({ agentId: 'a1', radarByPersona, profiles });
    expect(suite.dimVolatility.task).toBe(3);
    expect(suite.dimVolatility.quality).toBe(2);
  });

  it('个性化增量取逐原型相对中性基线的最大漂移', () => {
    const suite = computePersonaSuite({ agentId: 'a1', radarByPersona, profiles });
    // boss-growth: cost 漂移 2；boss-risk: task/quality/reliability 漂移 2
    expect(suite.personalizationDelta.perDim.reliability).toBe(2);
    expect(suite.personalizationDelta.perDim.cost).toBe(2);
    expect(suite.personalizationDelta.perDim.task).toBe(2);
    // 总 = (2+2+1+1+2+2)/6 ≈ 1.67
    expect(suite.personalizationDelta.total).toBeCloseTo(1.67, 2);
  });

  it('空 radarByPersona → 无中性锚点、无评估列、增量为 0', () => {
    const suite = computePersonaSuite({ agentId: 'a1', radarByPersona: {}, profiles });
    expect(suite.neutral).toBeNull();
    expect(suite.columns.filter((c) => c.radar).length).toBe(0);
    expect(suite.personalizationDelta.total).toBe(0);
    expect(suite.meanRadar.task).toBe(0);
  });

  it('部分原型未评估 → 仅已评估列参与均值/波动', () => {
    const partial: Record<string, RadarScore> = {
      [NEUTRAL_BOSS.id]: NEUTRAL_RADAR,
      'boss-risk': RISK_RADAR,
    };
    const suite = computePersonaSuite({ agentId: 'a1', radarByPersona: partial, profiles });
    expect(suite.columns.filter((c) => c.radar).length).toBe(2);
    // 仅 neutral + risk 两列：task (4,2) 波动 = 2
    expect(suite.dimVolatility.task).toBe(2);
  });
});
