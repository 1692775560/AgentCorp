/**
 * tests/unit/capsuleToItemBank.test.ts
 *
 * 群体胶囊 → 题库进化接线单测：
 * - deriveEvolutionAction：样本不足/低通过率/低区分度/高返工/低返工高通过/no-op
 * - applyDifficultyAdjustment：raise/lower/非难度动作
 * - aggregateItemSignal：聚合 capsule 为单题信号
 * - detectMissingTaskTypes：胶囊池高频但题库无对应
 */
import { describe, it, expect } from 'vitest';
import {
  deriveEvolutionAction,
  applyDifficultyAdjustment,
  aggregateItemSignal,
  detectMissingTaskTypes,
  DEFAULT_EVOLUTION_THRESHOLDS,
  type ItemEvolutionSignal,
} from '@/engine/experience/capsuleToItemBank';
import type { ExperienceCapsule } from '@/types/capsule';
import type { ItemSpec } from '@/engine/interview/itemBank';

function makeSignal(over: Partial<ItemEvolutionSignal> = {}): ItemEvolutionSignal {
  return {
    itemId: 'item-1',
    taskType: 'code-issue-fix',
    sampleSize: 5,
    approvalRate: 0.6,
    avgRework: 1,
    avgUserFit: 70,
    ...over,
  };
}

describe('deriveEvolutionAction', () => {
  it('样本不足 → no-op', () => {
    const r = deriveEvolutionAction(makeSignal({ sampleSize: 2 }));
    expect(r.action).toBe('no-op');
    expect(r.reason).toMatch(/样本不足/);
  });

  it('低通过率 → clone', () => {
    const r = deriveEvolutionAction(makeSignal({ approvalRate: 0.2 }));
    expect(r.action).toBe('clone');
    expect(r.reason).toMatch(/高频做错/);
  });

  it('低区分度（approvalRate≈0.5）→ add-canary', () => {
    const r = deriveEvolutionAction(makeSignal({ approvalRate: 0.5 }));
    expect(r.action).toBe('add-canary');
    expect(r.reason).toMatch(/低区分度/);
  });

  it('高返工 → raise-difficulty', () => {
    const r = deriveEvolutionAction(makeSignal({ avgRework: 2.5, approvalRate: 0.7 }));
    expect(r.action).toBe('raise-difficulty');
    expect(r.difficultyDelta).toBe(0.3);
  });

  it('高通过率+低返工 → lower-difficulty', () => {
    const r = deriveEvolutionAction(
      makeSignal({ approvalRate: 0.9, avgRework: 0.2 }),
    );
    expect(r.action).toBe('lower-difficulty');
    expect(r.difficultyDelta).toBe(-0.3);
  });

  it('正常区间 → no-op', () => {
    const r = deriveEvolutionAction(makeSignal({ approvalRate: 0.7, avgRework: 0.8 }));
    expect(r.action).toBe('no-op');
    expect(r.reason).toMatch(/正常区间/);
  });

  it('优先级：样本不足先于其他', () => {
    const r = deriveEvolutionAction(
      makeSignal({ sampleSize: 1, approvalRate: 0.1 }),
    );
    expect(r.action).toBe('no-op');
  });

  it('优先级：clone 先于 add-canary（极低通过率也算低区分度？不，clone 优先）', () => {
    // approvalRate=0.2 < clone 阈值 0.3 → clone（不是 add-canary）
    const r = deriveEvolutionAction(makeSignal({ approvalRate: 0.2 }));
    expect(r.action).toBe('clone');
  });
});

describe('applyDifficultyAdjustment', () => {
  function makeItem(over: Partial<ItemSpec> = {}): ItemSpec {
    return {
      id: 'item-1',
      stem: '示例题',
      phase: 'P1_understanding',
      jobType: 'code',
      params: { a: 1, b: 0, c: 0 },
      ...over,
    };
  }

  it('raise → b + 0.3', () => {
    const item = makeItem();
    const r = applyDifficultyAdjustment(item, {
      itemId: 'item-1',
      action: 'raise-difficulty',
      reason: 'x',
      difficultyDelta: 0.3,
    });
    expect(r.params?.b).toBe(0.3);
  });

  it('lower → b - 0.3', () => {
    const item = makeItem({ params: { a: 1, b: 1, c: 0 } });
    const r = applyDifficultyAdjustment(item, {
      itemId: 'item-1',
      action: 'lower-difficulty',
      reason: 'x',
      difficultyDelta: -0.3,
    });
    expect(r.params?.b).toBe(0.7);
  });

  it('非难度动作 → 原样返回', () => {
    const item = makeItem();
    const r = applyDifficultyAdjustment(item, {
      itemId: 'item-1',
      action: 'clone',
      reason: 'x',
    });
    expect(r).toBe(item);
  });

  it('b 夹取到 [-3, 3]', () => {
    const item = makeItem({ params: { a: 1, b: 2.9, c: 0 } });
    const r = applyDifficultyAdjustment(item, {
      itemId: 'item-1',
      action: 'raise-difficulty',
      reason: 'x',
      difficultyDelta: 0.5,
    });
    expect(r.params?.b).toBe(3);
  });
});

describe('aggregateItemSignal', () => {
  function makeCapsule(over: Partial<ExperienceCapsule & { itemId?: string }> = {}): ExperienceCapsule {
    return {
      capsuleId: 'c1',
      createdAt: '2025-01-01T00:00:00Z',
      taskId: 't1',
      taskTitle: '修复 issue',
      agentId: 'a1',
      agentName: 'Codex',
      jobType: 'code',
      radar: null,
      userFit: 70,
      reworkRounds: 1,
      approved: true,
      outputDigest: '',
      outputLength: 100,
      humanJudgment: 'approved',
      schemaVersion: 1,
      itemId: 'item-1',
      ...over,
    } as ExperienceCapsule & { itemId?: string };
  }

  it('无匹配 → null', () => {
    expect(aggregateItemSignal([], 'item-1')).toBeNull();
    expect(aggregateItemSignal([makeCapsule({ itemId: 'other' })], 'item-1')).toBeNull();
  });

  it('聚合：sampleSize/approvalRate/avgRework/avgUserFit', () => {
    const capsules = [
      makeCapsule({ itemId: 'item-1', approved: true, reworkRounds: 0, userFit: 80 }),
      makeCapsule({ itemId: 'item-1', approved: false, reworkRounds: 2, userFit: 60 }),
    ];
    const r = aggregateItemSignal(capsules, 'item-1');
    expect(r?.sampleSize).toBe(2);
    expect(r?.approvalRate).toBe(0.5);
    expect(r?.avgRework).toBe(1);
    expect(r?.avgUserFit).toBe(70);
  });

  it('taskType 由 capsule 推导', () => {
    const capsules = [makeCapsule({ itemId: 'item-1', taskTitle: '修复 GitHub issue' })];
    const r = aggregateItemSignal(capsules, 'item-1');
    expect(r?.taskType).toBe('code-issue-fix');
  });
});

describe('detectMissingTaskTypes', () => {
  it('胶囊池高频 taskType 题库无 → 标记 missing', () => {
    const capsules = Array.from({ length: 6 }, () => ({
      capsuleId: 'c',
      createdAt: '2025-01-01T00:00:00Z',
      taskId: 't',
      taskTitle: '多轮客服对话，遵守 policy 约束',
      agentId: 'a',
      agentName: 'X',
      jobType: 'text' as const,
      radar: null,
      approved: true,
      outputDigest: '',
      outputLength: 0,
      humanJudgment: 'approved' as const,
      schemaVersion: 1 as const,
    }));
    const items: ItemSpec[] = [
      { id: 'i1', stem: '单轮题', phase: 'P1_understanding', jobType: 'code' },
    ];
    const missing = detectMissingTaskTypes(capsules, items, 5);
    expect(missing).toContain('multi-turn-policy');
  });

  it('题库已有 → 不标记', () => {
    const capsules = Array.from({ length: 6 }, () => ({
      capsuleId: 'c',
      createdAt: '2025-01-01T00:00:00Z',
      taskId: 't',
      taskTitle: '单轮作答',
      agentId: 'a',
      agentName: 'X',
      jobType: 'code' as const,
      radar: null,
      approved: true,
      outputDigest: '',
      outputLength: 0,
      humanJudgment: 'approved' as const,
      schemaVersion: 1 as const,
    }));
    const items: ItemSpec[] = [
      { id: 'i1', stem: '单轮作答题', phase: 'P1_understanding', jobType: 'code' },
    ];
    const missing = detectMissingTaskTypes(capsules, items, 5);
    expect(missing).not.toContain('single-turn');
  });

  it('样本不足 → 不标记', () => {
    const capsules = Array.from({ length: 2 }, () => ({
      capsuleId: 'c',
      createdAt: '2025-01-01T00:00:00Z',
      taskId: 't',
      taskTitle: '多轮客服',
      agentId: 'a',
      agentName: 'X',
      jobType: 'text' as const,
      radar: null,
      approved: true,
      outputDigest: '',
      outputLength: 0,
      humanJudgment: 'approved' as const,
      schemaVersion: 1 as const,
    }));
    expect(detectMissingTaskTypes(capsules, [], 5)).toEqual([]);
  });
});

describe('DEFAULT_EVOLUTION_THRESHOLDS', () => {
  it('阈值合理', () => {
    expect(DEFAULT_EVOLUTION_THRESHOLDS.minSamples).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_EVOLUTION_THRESHOLDS.cloneApprovalThreshold).toBeLessThan(0.5);
    expect(DEFAULT_EVOLUTION_THRESHOLDS.easyApprovalThreshold).toBeGreaterThan(0.7);
  });
});
