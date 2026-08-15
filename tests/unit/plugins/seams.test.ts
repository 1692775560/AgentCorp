/**
 * tests/unit/plugins/seams.test.ts  (Option 1 · T5/T6 内核侧验证)
 * 验证能力 seam 的 Provider 注册 / 精确查找 / 默认选择（按 priority）/ 卸载回退，
 * 以及不同 kind（llm / judge）互不干扰。仅依赖内核，不引入仓库级缺失符号。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ctx } from '@/demo/plugins/context';
import { LLM_KIND, type LLMProvider } from '@/demo/plugins/seams/llm';
import { JUDGE_KIND } from '@/demo/plugins/seams/judge';

describe('Option1 capability seams (T5/T6 kernel side)', () => {
  beforeEach(() => ctx.clear());

  it('LLM seam：注册双 Provider，默认取 priority 高者，dispose 回退', () => {
    const fallback: LLMProvider = { id: 'fallback', complete: async () => 'fb' };
    const main: LLMProvider = { id: 'main', complete: async () => 'main' };
    ctx.registerProvider(LLM_KIND, 'fallback', fallback, 1);
    const dMain = ctx.registerProvider(LLM_KIND, 'main', main, 10);
    expect(ctx.getProvider<LLMProvider>(LLM_KIND, 'main')).toBe(main);
    expect(ctx.getDefaultProvider<LLMProvider>(LLM_KIND)).toBe(main);
    // 卸载默认 → 回退到次高 priority
    dMain.dispose();
    expect(ctx.getProvider<LLMProvider>(LLM_KIND, 'main')).toBeUndefined();
    expect(ctx.getDefaultProvider<LLMProvider>(LLM_KIND)).toBe(fallback);
  });

  it('Judge seam：独立 kind，与 LLM 互不干扰', () => {
    const jp = {
      id: 'mock',
      judge: async () => ({ radar: {}, verdict: 'OBSERVE', confidence: 0.5, evidence: [] }),
    };
    ctx.registerProvider(JUDGE_KIND, 'mock', jp, 5);
    expect(ctx.getDefaultProvider(JUDGE_KIND)).toBe(jp);
    // LLM kind 不受 judge 注册影响
    expect(ctx.getDefaultProvider(LLM_KIND)).toBeUndefined();
  });
});
