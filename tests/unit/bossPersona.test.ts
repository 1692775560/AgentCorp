/**
 * tests/unit/bossPersona.test.ts
 * A · 人格化评估（老板原型 BossProfile）单测。
 *
 * 覆盖三处注入点的纯函数与引擎级接线：
 *  - bossPersonaBoost：BossProfile → 六维强调系数（>1 表示加强）
 *  - mergeBoost：任务侧(dimBoost) + 用户侧(personaBoost) 合并（同维 va+vb−1）
 *  - buildPersonaPreamble：中性/无画像 → ''；非中性 → 裁判前缀段落
 *  - selectQuestions 接线：persona 改变 P1 考查维度增强与 P3 选题排序
 *  - judgeChat 接线：persona 非空时把前缀注入 transcript 再发 /api/chat-judge
 *
 * 不触达网络：judgeChat 走 '@/lib/host-api' 的 hostApiFetch（主进程代理），
 * 测试直接 mock 该模块，断言转发路径与请求体。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const refs = vi.hoisted(() => ({ hostApiFetch: vi.fn() }));

// judgeChat 经 hostApiFetch（主进程代持 token 转发）调 /api/chat-judge
vi.mock('@/lib/host-api', () => ({
  hostApiFetch: refs.hostApiFetch,
  hostApiStream: vi.fn(async () => { throw new Error('no stream in test'); }),
}));

import {
  bossPersonaBoost,
  mergeBoost,
  selectQuestions,
} from '@/engine/interview/questionBank';
import { buildPersonaPreamble, judgeChat } from '@/services/judgeClient';
import { NEUTRAL_BOSS, type BossProfile } from '@/types/evaluation';

/** 与 src/stores/bossProfile.ts 的 BOSS_PRESETS 对齐（独立构造，不耦合 store 实现） */
const BOSS_GROWTH: BossProfile = {
  id: 'boss-growth',
  name: '成长型老板',
  domain: '业务增长',
  experienceLevel: 'intermediate',
  riskAversion: 'low',
  communicationStyle: 'concise',
  constraintPrefs: ['speed', 'cost'],
};
const BOSS_RISK: BossProfile = {
  id: 'boss-risk',
  name: '风险厌恶老板',
  domain: '合规/金融',
  experienceLevel: 'expert',
  riskAversion: 'high',
  communicationStyle: 'detailed',
  constraintPrefs: ['safety', 'quality'],
};

describe('bossPersonaBoost', () => {
  it('null / undefined → 空系数（退化为中性基线）', () => {
    expect(bossPersonaBoost(null)).toEqual({});
    expect(bossPersonaBoost(undefined)).toEqual({});
  });

  it('中性老板（仅 id） → 空系数', () => {
    expect(bossPersonaBoost(NEUTRAL_BOSS)).toEqual({});
  });

  it('成长型老板：task/creativity/comm/cost 被强调，且系数严格 >1', () => {
    const boost = bossPersonaBoost(BOSS_GROWTH);
    expect(boost).toEqual({
      task: 1.25,
      creativity: 1.1,
      comm: 1.15,
      cost: 1.35,
    });
    for (const v of Object.values(boost)) expect(v).toBeGreaterThan(1);
  });

  it('风险厌恶老板：reliability/quality/comm/creativity 被强调', () => {
    const boost = bossPersonaBoost(BOSS_RISK);
    expect(boost).toEqual({
      creativity: 1.2,
      quality: 1.55,
      reliability: 1.6,
      comm: 1.2,
    });
    for (const v of Object.values(boost)) expect(v).toBeGreaterThan(1);
  });
});

describe('mergeBoost', () => {
  it('同维系数相加再减 1（避免双重加成）', () => {
    expect(mergeBoost({ task: 1.25 }, { task: 1.35 })).toEqual({ task: 1.6 });
  });

  it('异维系数并集（各自保持 va+1−1=va）', () => {
    expect(mergeBoost({ task: 1.25 }, { cost: 1.35 })).toEqual({
      task: 1.25,
      cost: 1.35,
    });
  });

  it('单侧为 undefined 时退化为另一侧', () => {
    expect(mergeBoost(undefined, { task: 1.3 })).toEqual({ task: 1.3 });
    expect(mergeBoost({ task: 1.3 }, undefined)).toEqual({ task: 1.3 });
  });

  it('合并后均 ≤1 的维被滤除', () => {
    // 1.001 阈值：并发两维各 1.0005 → 合并 1.0010 ≤ 1.001 被剔除
    expect(mergeBoost({ task: 1.0005 }, { task: 1.0005 })).toEqual({});
  });
});

describe('buildPersonaPreamble', () => {
  it('中性 / null / undefined → 空串（不污染离线基线评估）', () => {
    expect(buildPersonaPreamble(NEUTRAL_BOSS)).toBe('');
    expect(buildPersonaPreamble(null)).toBe('');
    expect(buildPersonaPreamble(undefined)).toBe('');
  });

  it('非中性 → 以 [评估上下文 · 老板原型] 开头并含关键字段', () => {
    const pre = buildPersonaPreamble(BOSS_RISK);
    expect(pre.startsWith('[评估上下文 · 老板原型]')).toBe(true);
    expect(pre).toContain('风险偏好：high');
    expect(pre).toContain('约束偏好：safety、quality');
    expect(pre).toContain('原型名：风险厌恶老板');
  });
});

describe('selectQuestions 接线（persona 改变选题）', () => {
  it('P1 阶段把老板强调维并入考查维度', () => {
    const plan = selectQuestions({ jobType: 'code', persona: BOSS_RISK });
    const p1 = plan.find((q) => q.qId === 'p1_restate');
    expect(p1).toBeDefined();
    // 风险老板强调 reliability/quality/comm/creativity，应被追加强化到 P1 题
    expect(p1!.targetDims).toContain('reliability');
    expect(p1!.targetDims).toContain('quality');
  });

  it('无 persona vs 风险老板：P3 选题排序不同（可靠性重题前置）', () => {
    const neutralPlan = selectQuestions({ jobType: 'code' }); // persona 缺省
    const riskPlan = selectQuestions({ jobType: 'code', persona: BOSS_RISK });

    const neutralP3 = neutralPlan
      .filter((q) => q.phase === 'P3_pressure')
      .map((q) => q.qId)
      .slice(0, 4);
    const riskP3 = riskPlan
      .filter((q) => q.phase === 'P3_pressure')
      .map((q) => q.qId)
      .slice(0, 4);

    // 无个性化：区分性题按题库顺序前置（信息残缺→冲突→越权→成本）
    expect(neutralP3).toEqual([
      'p3_incomplete',
      'p3_conflict',
      'p3_overreach',
      'p3_cost_bound',
    ]);
    // 风险老板：可靠性加权使 p3_failure 顶入前 4，p3_cost_bound 被挤出
    expect(riskP3).toEqual([
      'p3_incomplete',
      'p3_conflict',
      'p3_overreach',
      'p3_failure',
    ]);
    expect(riskP3).toContain('p3_failure');
    expect(riskP3).not.toContain('p3_cost_bound');
  });
});

describe('judgeChat 接线（persona 注入裁判前缀）', () => {
  const REAL_RADAR = {
    task: 4,
    quality: 4,
    comm: 4,
    creativity: 4,
    reliability: 4,
    cost: 4,
  };

  beforeEach(() => {
    refs.hostApiFetch.mockReset();
  });

  it('persona 非空 → 前缀注入 transcript 后再发 /api/chat-judge', async () => {
    refs.hostApiFetch.mockResolvedValue({ source: 'judge', radar: REAL_RADAR, confidence: 0.9 });
    const res = await judgeChat('agent-x', '原始对话文本', BOSS_RISK);
    expect(refs.hostApiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = refs.hostApiFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe('/api/chat-judge');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.transcript).toContain('[评估上下文 · 老板原型]');
    expect(body.transcript).toContain('风险偏好：high');
    expect(body.transcript).toContain('原始对话文本');
    expect(res?.source).toBe('judge');
    expect(res?.radar).toEqual(REAL_RADAR);
  });

  it('persona 为空 → transcript 不加 persona/history 前缀（但抗偏差 rubric 锚定始终注入）', async () => {
    refs.hostApiFetch.mockResolvedValue({ source: 'degraded', radar: REAL_RADAR, confidence: 0.5 });
    await judgeChat('agent-x', '原始对话文本', null);
    const body = JSON.parse((refs.hostApiFetch.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.transcript).toContain('原始对话文本');
    expect(body.transcript).toContain('[评分准则 · 抗偏差锚定]');
    expect(body.transcript).not.toContain('[评估上下文 · 老板原型]');
    expect(body.transcript).not.toContain('[评估上下文 · 历史协作]');
  });

  it('代理失败 → 返回 null 而不是抛出（调用方据此走降级展示）', async () => {
    refs.hostApiFetch.mockRejectedValue(new Error('host api down'));
    await expect(judgeChat('agent-x', '文本', null)).resolves.toBeNull();
  });
});
