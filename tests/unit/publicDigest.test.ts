/**
 * tests/unit/publicDigest.test.ts
 *
 * 群体经验共享的脱敏 + 包导入/导出 + 群体检索/绩效单测：
 * - capsuleToPublic：去掉一切内容字段，只留评测信号
 * - buildPublicPackage / parsePublicPackage：包格式校验 + 损坏条目跳过
 * - findSimilarPublicCapsules / summarizePublicAgentPerformance：群体检索与绩效
 * - hashClientId：非可逆、同一输入同一输出
 */
import { describe, it, expect } from 'vitest';

import {
  capsuleToPublic,
  buildPublicPackage,
  parsePublicPackage,
  findSimilarPublicCapsules,
  summarizePublicAgentPerformance,
  hashClientId,
} from '@/engine/experience/publicDigest';
import type { ExperienceCapsule } from '@/types/capsule';
import type { RadarScore } from '@/types/evaluation';

const RADAR: RadarScore = {
  task: 3.5,
  quality: 4,
  comm: 3,
  creativity: 2.5,
  reliability: 4,
  cost: 3,
};

function makeCapsule(over: Partial<ExperienceCapsule> = {}): ExperienceCapsule {
  return {
    capsuleId: 'cap-1',
    createdAt: '2025-01-01T00:00:00Z',
    taskId: 'task-secret',
    taskTitle: '为 ACME 公司写季度报告',
    taskDescriptionDigest: '包含财务数据与客户名单',
    agentId: 'agent-1',
    agentName: 'Codex',
    jobType: 'code',
    radar: RADAR,
    userFit: 72,
    reworkRounds: 1,
    approved: true,
    outputLength: 500,
    outputDigest: '我完成了 ACME 的季度报告，包含…',
    runId: 'run-secret',
    sessionId: 'sess-secret',
    sessionKey: 'agent:leader:sess-secret',
    humanJudgment: 'approved',
    rootSessionId: 'root-secret',
    schemaVersion: 1,
    ...over,
  };
}

describe('capsuleToPublic（脱敏）', () => {
  it('★ 去掉一切内容字段（隐私面）', () => {
    const pub = capsuleToPublic(makeCapsule());
    // 保留的评测信号
    expect(pub.capsuleId).toBe('cap-1');
    expect(pub.createdAt).toBe('2025-01-01T00:00:00Z');
    expect(pub.jobType).toBe('code');
    expect(pub.radar).toEqual(RADAR);
    expect(pub.agentId).toBe('agent-1');
    expect(pub.userFit).toBe(72);
    expect(pub.reworkRounds).toBe(1);
    expect(pub.approved).toBe(true);
    expect(pub.humanJudgment).toBe('approved');
    expect(pub.schemaVersion).toBe(1);
  });

  it('★ 隐私字段绝不进入公共胶囊', () => {
    const pub = capsuleToPublic(makeCapsule());
    // 内容字段必须不存在
    expect(pub).not.toHaveProperty('taskTitle');
    expect(pub).not.toHaveProperty('taskDescriptionDigest');
    expect(pub).not.toHaveProperty('outputDigest');
    expect(pub).not.toHaveProperty('outputLength');
    expect(pub).not.toHaveProperty('sessionId');
    expect(pub).not.toHaveProperty('sessionKey');
    expect(pub).not.toHaveProperty('rootSessionId');
    expect(pub).not.toHaveProperty('taskId');
    expect(pub).not.toHaveProperty('agentName');
  });

  it('sourceClientId → 非可逆 hash', () => {
    const pub = capsuleToPublic(makeCapsule(), { sourceClientId: 'user-abc' });
    expect(pub.sourceClientHash).toMatch(/^[0-9a-f]{16}$/);
    expect(pub.sourceClientHash).not.toBe('user-abc'); // 不可逆
  });

  it('无 sourceClientId → hash=null', () => {
    const pub = capsuleToPublic(makeCapsule());
    expect(pub.sourceClientHash).toBeNull();
  });

  it('appVersion 透传', () => {
    const pub = capsuleToPublic(makeCapsule(), { appVersion: '0.3.0' });
    expect(pub.appVersion).toBe('0.3.0');
  });
});

describe('hashClientId（非可逆）', () => {
  it('同一输入同一输出', () => {
    expect(hashClientId('user-abc')).toBe(hashClientId('user-abc'));
  });

  it('不同输入不同输出', () => {
    expect(hashClientId('user-abc')).not.toBe(hashClientId('user-abd'));
  });

  it('空输入返回空串', () => {
    expect(hashClientId('')).toBe('');
  });
});

describe('buildPublicPackage / parsePublicPackage', () => {
  it('build → parse 往返一致', () => {
    const capsules = [makeCapsule({ capsuleId: 'a' }), makeCapsule({ capsuleId: 'b' })];
    const pkg = buildPublicPackage(capsules, { sourceClientId: 'user-x', appVersion: '0.3.0' });
    const json = JSON.stringify(pkg);
    const parsed = parsePublicPackage(json);
    expect(parsed.ok).toBe(true);
    expect(parsed.capsules).toHaveLength(2);
    expect(parsed.skipped).toBe(0);
    expect(parsed.capsules[0].capsuleId).toBe('a');
    expect(parsed.capsules[0].sourceClientHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('parse 拒绝 kind 不匹配', () => {
    const r = parsePublicPackage({ kind: 'other', schemaVersion: 1, capsules: [] });
    expect(r.ok).toBe(false);
    expect(r.capsules).toHaveLength(0);
  });

  it('parse 拒绝 schemaVersion 不支持', () => {
    const r = parsePublicPackage({
      kind: 'agentcorp-public-capsules',
      schemaVersion: 99,
      capsules: [],
    });
    expect(r.ok).toBe(false);
  });

  it('parse 跳过不合法条目，合法条目仍导入', () => {
    const pkg = {
      kind: 'agentcorp-public-capsules',
      schemaVersion: 1,
      capsules: [
        { capsuleId: 'good-1', agentId: 'a', createdAt: '2025-01-01T00:00:00Z', schemaVersion: 1 },
        { capsuleId: 'bad', agentId: undefined }, // 缺 agentId
        'not-an-object',
        { capsuleId: 'good-2', agentId: 'b', createdAt: '2025-01-02T00:00:00Z', schemaVersion: 1 },
      ],
    };
    const r = parsePublicPackage(pkg);
    expect(r.ok).toBe(true);
    expect(r.capsules).toHaveLength(2);
    expect(r.skipped).toBe(2);
  });

  it('parse 非法 JSON 字符串返回 ok=false', () => {
    const r = parsePublicPackage('not json');
    expect(r.ok).toBe(false);
  });
});

describe('findSimilarPublicCapsules', () => {
  function makePub(over: Partial<{ capsuleId: string; jobType: 'code' | 'text' | null; agentId: string; approved: boolean | null; createdAt: string }> = {}): ReturnType<typeof capsuleToPublic> {
    return capsuleToPublic(makeCapsule({
      capsuleId: over.capsuleId ?? 'p1',
      jobType: over.jobType ?? 'code',
      agentId: over.agentId ?? 'a',
      approved: over.approved ?? true,
      createdAt: over.createdAt ?? '2025-01-01T00:00:00Z',
    }));
  }

  it('按 jobType 过滤', () => {
    const list = [makePub({ jobType: 'code' }), makePub({ jobType: 'text', agentId: 'b' })];
    const r = findSimilarPublicCapsules(list, { jobType: 'code' });
    expect(r).toHaveLength(1);
    expect(r[0].jobType).toBe('code');
  });

  it('按 agentId 过滤', () => {
    const list = [makePub({ agentId: 'a' }), makePub({ agentId: 'b' })];
    const r = findSimilarPublicCapsules(list, { agentId: 'a' });
    expect(r).toHaveLength(1);
    expect(r[0].agentId).toBe('a');
  });

  it('approved=true 优先', () => {
    const list = [
      makePub({ agentId: 'a', approved: false, createdAt: '2025-01-02T00:00:00Z' }),
      makePub({ agentId: 'a', approved: true, createdAt: '2025-01-01T00:00:00Z' }),
    ];
    const r = findSimilarPublicCapsules(list, { agentId: 'a' });
    expect(r[0].approved).toBe(true);
  });
});

describe('summarizePublicAgentPerformance', () => {
  function makePub(over: Partial<{ agentId: string; jobType: 'code' | 'text' | null; approved: boolean | null; reworkRounds: number; userFit: number | null }> = {}): ReturnType<typeof capsuleToPublic> {
    return capsuleToPublic(makeCapsule({
      agentId: over.agentId ?? 'a',
      jobType: over.jobType ?? 'code',
      approved: over.approved ?? true,
      reworkRounds: over.reworkRounds ?? 0,
      userFit: over.userFit ?? 70,
    }));
  }

  it('无样本返回 null', () => {
    expect(summarizePublicAgentPerformance([], 'x')).toBeNull();
  });

  it('有样本：计算 approvalRate / avgRework / avgUserFit', () => {
    const list = [
      makePub({ agentId: 'a', approved: true, reworkRounds: 0, userFit: 80 }),
      makePub({ agentId: 'a', approved: false, reworkRounds: 2, userFit: 60 }),
      makePub({ agentId: 'a', approved: true, reworkRounds: 1, userFit: 70 }),
    ];
    const r = summarizePublicAgentPerformance(list, 'a');
    expect(r?.sampleSize).toBe(3);
    expect(r?.approvalRate).toBeCloseTo(2 / 3);
    expect(r?.avgRework).toBeCloseTo(1);
    expect(r?.avgUserFit).toBeCloseTo(70);
  });

  it('jobType 过滤：其他工种不计入', () => {
    const list = [
      makePub({ agentId: 'a', jobType: 'code' }),
      makePub({ agentId: 'a', jobType: 'text' }),
    ];
    expect(summarizePublicAgentPerformance(list, 'a', 'code')?.sampleSize).toBe(1);
  });
});
