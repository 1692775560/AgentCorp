/**
 * tests/unit/capsule.test.ts
 *
 * 经验胶囊纯函数单测：
 * - buildCapsule：完整字段 / profile 缺失 / 交付摘要长度限制
 * - findSimilarCapsules：jobType/agentId/approved 过滤 + 排序
 * - summarizeAgentPerformance：有样本 / 无样本 / 部分 userFit 缺失
 */
import { describe, it, expect } from 'vitest';

import { buildCapsule, findSimilarCapsules, summarizeAgentPerformance } from '@/engine/experience/capsule';
import type { CapsuleWorkInput } from '@/engine/experience/capsule';
import type { EvaluationProfile, RadarScore } from '@/types/evaluation';

const RADAR: RadarScore = {
  task: 3.5,
  quality: 4,
  comm: 3,
  creativity: 2.5,
  reliability: 4,
  cost: 3,
};

const PROFILE = {
  agentId: 'agent-1',
  radarLatest: RADAR,
  radarHistory: [RADAR],
  kpiLatest: {} as never,
  kpiHistory: [],
  roiLatest: {} as never,
  lifecycle: 'ACTIVE' as never,
  runIds: [],
  updatedAt: '2025-01-01T00:00:00Z',
  userFitLatest: 72,
  jobType: 'code' as const,
} as unknown as EvaluationProfile;

function makeWork(over: Partial<CapsuleWorkInput> = {}): CapsuleWorkInput {
  return {
    taskId: 'task-1',
    taskTitle: '写登录页',
    taskDescription: '实现登录表单 + 验证',
    agentId: 'agent-1',
    agentName: 'Codex',
    output: '我完成了登录页，包含表单验证和错误提示，共 200 行代码。',
    runId: 'run-1',
    sessionId: 'sess-1',
    sessionKey: 'agent:leader:sess-1',
    reworkRounds: 1,
    approved: true,
    ...over,
  };
}

describe('buildCapsule', () => {
  it('完整字段：从 work + profile 组装', () => {
    const c = buildCapsule(makeWork(), PROFILE);
    expect(c.taskId).toBe('task-1');
    expect(c.taskTitle).toBe('写登录页');
    expect(c.agentId).toBe('agent-1');
    expect(c.agentName).toBe('Codex');
    expect(c.jobType).toBe('code');
    expect(c.radar).toEqual(RADAR);
    expect(c.userFit).toBe(72);
    expect(c.reworkRounds).toBe(1);
    expect(c.approved).toBe(true);
    expect(c.humanJudgment).toBe('approved');
    expect(c.runId).toBe('run-1');
    expect(c.rootSessionId).toBe('agent:leader:sess-1');
    expect(c.schemaVersion).toBe(1);
    expect(c.capsuleId).toMatch(/^cap-\d+-[a-z0-9]+$/);
    expect(c.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('交付摘要限制：超 200 字截断，存长度', () => {
    const longOutput = 'x'.repeat(500);
    const c = buildCapsule(makeWork({ output: longOutput }), PROFILE);
    expect(c.outputLength).toBe(500);
    expect(c.outputDigest.length).toBe(200);
  });

  it('任务描述摘要限制：超 120 字截断', () => {
    const longDesc = 'y'.repeat(200);
    const c = buildCapsule(makeWork({ taskDescription: longDesc }), PROFILE);
    expect(c.taskDescriptionDigest?.length).toBe(120);
  });

  it('profile 缺失：radar=null，不编造', () => {
    const c = buildCapsule(makeWork(), null);
    expect(c.radar).toBeNull();
    expect(c.userFit).toBeNull();
    expect(c.jobType).toBeNull();
  });

  it('approved=false → humanJudgment=rejected', () => {
    const c = buildCapsule(makeWork({ approved: false }), PROFILE);
    expect(c.humanJudgment).toBe('rejected');
  });

  it('approved 未提供 → humanJudgment=neutral', () => {
    const work = makeWork();
    delete (work as Partial<CapsuleWorkInput>).approved;
    const c = buildCapsule(work, PROFILE);
    expect(c.humanJudgment).toBe('neutral');
    expect(c.approved).toBeNull();
  });
});

describe('findSimilarCapsules', () => {
  function makeCapsule(over: Partial<Parameters<typeof buildCapsule>[0]> & {
    jobType?: 'code' | 'text' | 'image' | null;
    agentId?: string;
    approved?: boolean | null;
    createdAt?: string;
  }): ReturnType<typeof buildCapsule> {
    const work = makeWork({
      agentId: over.agentId ?? 'agent-1',
      approved: over.approved ?? true,
    });
    const c = buildCapsule(work, { ...PROFILE, jobType: over.jobType ?? 'code' });
    return { ...c, ...over } as ReturnType<typeof buildCapsule>;
  }

  it('按 jobType 过滤', () => {
    const list = [
      makeCapsule({ jobType: 'code', agentId: 'a', createdAt: '2025-01-01T00:00:00Z' }),
      makeCapsule({ jobType: 'text', agentId: 'b', createdAt: '2025-01-02T00:00:00Z' }),
    ];
    const r = findSimilarCapsules(list, { jobType: 'code' });
    expect(r).toHaveLength(1);
    expect(r[0].agentId).toBe('a');
  });

  it('按 agentId 过滤', () => {
    const list = [
      makeCapsule({ agentId: 'a', createdAt: '2025-01-01T00:00:00Z' }),
      makeCapsule({ agentId: 'b', createdAt: '2025-01-02T00:00:00Z' }),
    ];
    const r = findSimilarCapsules(list, { agentId: 'a' });
    expect(r).toHaveLength(1);
    expect(r[0].agentId).toBe('a');
  });

  it('approved=true 优先排序（同 agentId 时 approved 排前）', () => {
    const list = [
      makeCapsule({ agentId: 'a', approved: false, createdAt: '2025-01-02T00:00:00Z' }),
      makeCapsule({ agentId: 'a', approved: true, createdAt: '2025-01-01T00:00:00Z' }),
    ];
    const r = findSimilarCapsules(list, { agentId: 'a' });
    expect(r[0].approved).toBe(true);
  });

  it('limit 限制返回数', () => {
    const list = Array.from({ length: 10 }, (_, i) =>
      makeCapsule({ agentId: 'a', createdAt: `2025-01-0${i + 1}T00:00:00Z` }),
    );
    const r = findSimilarCapsules(list, { agentId: 'a', limit: 3 });
    expect(r).toHaveLength(3);
  });

  it('无匹配返回空数组', () => {
    const list = [makeCapsule({ agentId: 'a' })];
    const r = findSimilarCapsules(list, { agentId: 'never' });
    expect(r).toEqual([]);
  });
});

describe('summarizeAgentPerformance', () => {
  function makeCapsuleForPerf(
    agentId: string,
    over: { jobType?: 'code' | 'text' | null; approved?: boolean | null; reworkRounds?: number; userFit?: number | null },
  ): ReturnType<typeof buildCapsule> {
    const work = makeWork({
      agentId,
      approved: over.approved ?? true,
      reworkRounds: over.reworkRounds ?? 0,
    });
    const profile = { ...PROFILE, jobType: over.jobType ?? 'code', userFitLatest: over.userFit ?? null };
    return buildCapsule(work, profile);
  }

  it('无样本返回 null（不编造）', () => {
    const r = summarizeAgentPerformance([], 'agent-x');
    expect(r).toBeNull();
  });

  it('有样本：计算 approvalRate / avgRework / avgUserFit', () => {
    const list = [
      makeCapsuleForPerf('a', { approved: true, reworkRounds: 0, userFit: 80 }),
      makeCapsuleForPerf('a', { approved: false, reworkRounds: 2, userFit: 60 }),
      makeCapsuleForPerf('a', { approved: true, reworkRounds: 1, userFit: 70 }),
    ];
    const r = summarizeAgentPerformance(list, 'a');
    expect(r).not.toBeNull();
    expect(r?.sampleSize).toBe(3);
    expect(r?.approvalRate).toBeCloseTo(2 / 3);
    expect(r?.avgRework).toBeCloseTo(1);
    expect(r?.avgUserFit).toBeCloseTo(70);
  });

  it('userFit 全缺失时 avgUserFit=null', () => {
    const list = [
      makeCapsuleForPerf('a', { userFit: null, approved: true }),
    ];
    const r = summarizeAgentPerformance(list, 'a');
    expect(r?.avgUserFit).toBeNull();
    expect(r?.sampleSize).toBe(1);
  });

  it('jobType 过滤：其他工种不计入', () => {
    const list = [
      makeCapsuleForPerf('a', { jobType: 'code', approved: true }),
      makeCapsuleForPerf('a', { jobType: 'text', approved: true }),
    ];
    const r = summarizeAgentPerformance(list, 'a', 'code');
    expect(r?.sampleSize).toBe(1);
  });
});
