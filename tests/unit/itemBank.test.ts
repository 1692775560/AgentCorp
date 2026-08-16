/**
 * tests/unit/itemBank.test.ts
 * 题库工程与抗污染引擎的行为锁定。
 *
 * 覆盖：
 * - itemParams：默认参数与非法输入兜底
 * - cloneItem：确定性（同 seed 同输出）、难度等价（b 抖动 ≤0.2）、数量正确
 * - selectRotationWindow：轮换周期过滤（过期题移出、新题保留）
 * - pickVariantForCandidate：同候选同变体、不同候选可不同变体
 * - assembleCanaryPayload / canaryProbe：泄漏检测命中与未命中
 */
import { describe, it, expect } from 'vitest';
import {
  itemParams,
  cloneItem,
  selectRotationWindow,
  pickVariantForCandidate,
  assembleCanaryPayload,
  canaryProbe,
  CANARY_PREFIX,
  type ItemSpec,
} from '@/engine/interview/itemBank';

function makeItem(partial: Partial<ItemSpec> = {}): ItemSpec {
  return {
    id: 'q-task',
    stem: '请说明你会如何完成这个任务，并给出具体方案。',
    phase: 'P2_craft_probe',
    ...partial,
  };
}

describe('itemBank · itemParams', () => {
  it('无参数 → 默认 (a=1, b=0, c=0)', () => {
    const p = itemParams({ params: null });
    expect(p).toEqual({ a: 1, b: 0, c: 0 });
  });

  it('非法参数 → 兜底默认', () => {
    const p = itemParams({ params: { a: -1, b: Number.NaN, c: 5 } } as ItemSpec);
    expect(p.a).toBe(1);
    expect(p.b).toBe(0);
    expect(p.c).toBe(0);
  });

  it('合法参数原样保留', () => {
    const p = itemParams({ params: { a: 1.5, b: 0.8, c: 0.2 } } as ItemSpec);
    expect(p).toEqual({ a: 1.5, b: 0.8, c: 0.2 });
  });
});

describe('itemBank · cloneItem', () => {
  it('默认生成 3 个变体，共享 itemId', () => {
    const variants = cloneItem(makeItem());
    expect(variants).toHaveLength(3);
    for (const v of variants) {
      expect(v.itemId).toBe('q-task');
      expect(v.id.startsWith('q-task::v')).toBe(true);
      expect(v.stem.length).toBeGreaterThan(0);
    }
  });

  it('确定性：同 seed 同输出', () => {
    const a = cloneItem(makeItem(), { seed: 'fixed-seed' });
    const b = cloneItem(makeItem(), { seed: 'fixed-seed' });
    expect(a).toEqual(b);
  });

  it('变体难度等价：b 抖动不超过 ±0.2', () => {
    const variants = cloneItem(makeItem({ params: { a: 1, b: 0.5, c: 0 } }));
    for (const v of variants) {
      expect(Math.abs(v.params.b - 0.5)).toBeLessThanOrEqual(0.2 + 1e-9);
    }
  });

  it('可指定变体数量', () => {
    expect(cloneItem(makeItem(), { count: 5 })).toHaveLength(5);
  });
});

describe('itemBank · selectRotationWindow', () => {
  it('超过轮换周期的题被移出', () => {
    const old = makeItem({ id: 'old', addedAt: '2020-01-01T00:00:00Z', rotationDays: 30 });
    const fresh = makeItem({ id: 'fresh', addedAt: '2026-08-01T00:00:00Z', rotationDays: 30 });
    const { items, rotatedOut } = selectRotationWindow([old, fresh], {
      now: '2026-08-14T00:00:00Z',
      variantsPerItem: 1,
    });
    expect(rotatedOut).toContain('old');
    expect(items.map((v) => v.itemId)).toEqual(['fresh']);
  });

  it('无 addedAt 的题视为新题永不轮换', () => {
    const noDate = makeItem({ id: 'nodate' });
    const { rotatedOut, items } = selectRotationWindow([noDate], {
      now: '2026-08-14T00:00:00Z',
    });
    expect(rotatedOut).toHaveLength(0);
    expect(items.length).toBeGreaterThan(0);
  });

  it('窗口内变体数量 = variantsPerItem', () => {
    const item = makeItem({ id: 'q', addedAt: '2026-08-01T00:00:00Z' });
    const { items } = selectRotationWindow([item], {
      now: '2026-08-14T00:00:00Z',
      variantsPerItem: 4,
    });
    expect(items).toHaveLength(4);
  });
});

describe('itemBank · pickVariantForCandidate', () => {
  const variants = cloneItem(makeItem());

  it('同候选恒定拿同一变体（防背题）', () => {
    const a = pickVariantForCandidate(variants, 'cand-1');
    const b = pickVariantForCandidate(variants, 'cand-1');
    expect(a?.id).toBe(b?.id);
  });

  it('空变体 → null', () => {
    expect(pickVariantForCandidate([], 'x')).toBeNull();
  });

  it('无候选 id → 取第 0 个变体', () => {
    expect(pickVariantForCandidate(variants, '')?.id).toBe(variants[0].id);
  });
});

describe('itemBank · canary 泄漏检测', () => {
  it('可见模式：题面含 canary 注释', () => {
    const payload = assembleCanaryPayload('题目');
    expect(payload).toContain(CANARY_PREFIX);
    expect(payload).toContain('<!-- canary:');
  });

  it('不可见模式：零宽字符包裹仍可 grep 检出', () => {
    const payload = assembleCanaryPayload('题目', { visible: false });
    expect(payload).toContain(CANARY_PREFIX);
  });

  it('命中：外部题库包含 canary → 判定泄漏', () => {
    const leaked = `这份题库看起来是内部资料\n${assembleCanaryPayload('某题', { visible: false })}`;
    expect(canaryProbe(leaked).leaked).toBe(true);
  });

  it('未命中：干净题库 → 不判定泄漏', () => {
    expect(canaryProbe('完全无关的公开题目文本').leaked).toBe(false);
  });

  it('自定义 canary 可用', () => {
    const custom = 'custom-canary-xyz';
    const payload = assembleCanaryPayload('题目', { canary: custom });
    expect(canaryProbe(payload, { canary: custom }).leaked).toBe(true);
    expect(canaryProbe(payload).leaked).toBe(false);
  });
});
