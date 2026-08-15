/**
 * tests/unit/plugins/context.test.ts  (Option 1 · T1-T3 验证)
 * 校验可逆注册内核：register 返回 Disposable、dispose/unregister 卸载、applyPatch 覆盖与回滚、
 * ctx.on 事件订阅、向后兼容 API（registerSkill/getSkill/listSkills）。
 *
 * 位置说明：vitest include 仅覆盖 tests/unit/**，故置于此处（原 src/demo/plugins/context.test.ts
 * 不会被发现）。仅依赖内核与 registry，不引入任何会触发仓库级 tsc 缺失符号的模块，可独立验证。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ctx } from '@/demo/plugins/context';
import {
  registerSkill,
  getSkill,
  listSkills,
  unregister,
  applyPatch,
  resetSkills,
  type SkillDefinition,
} from '@/demo/skills/registry';

function makeDef(id: string): SkillDefinition {
  return {
    id,
    name: id,
    purpose: '',
    inputs: '',
    outputs: '',
    invokeCondition: '',
    dependsOn: [],
    failureHandling: '',
    securityBoundary: '',
    reuseValue: '',
    collaboration: '',
    ownerAgent: 'boss',
    handler: async () => ({ ok: true, degraded: false }),
  };
}

describe('Option1 plugin kernel (T1-T3)', () => {
  beforeEach(() => resetSkills());

  it('register 返回可释放 Disposable，dispose 即卸载（unwind）', () => {
    const d = registerSkill(makeDef('s1'));
    expect(typeof d.dispose).toBe('function');
    expect(getSkill('s1')).toBeDefined();
    d.dispose();
    expect(getSkill('s1')).toBeUndefined();
  });

  it('unregister 显式注销并返回是否成功', () => {
    registerSkill(makeDef('s2'));
    expect(unregister('s2')).toBe(true);
    expect(getSkill('s2')).toBeUndefined();
    expect(unregister('s2')).toBe(false);
  });

  it('applyPatch 覆盖既有 Skill，dispose patch 即回滚', () => {
    registerSkill(makeDef('s3'));
    const p = applyPatch({ priority: 10, target: 'skill', id: 's3', override: { purpose: 'patched' } });
    expect(getSkill('s3')!.purpose).toBe('patched');
    p.dispose();
    expect(getSkill('s3')!.purpose).toBe('');
  });

  it('ctx.on 订阅 agent/registered：注册触发、退订后不再触发', () => {
    const events: string[] = [];
    const off = ctx.on('agent/registered', (e) => events.push(e.id));
    ctx.register(makeDef('s4'));
    expect(events).toContain('s4');
    off.dispose();
    ctx.register(makeDef('s5'));
    expect(events).not.toContain('s5');
  });

  it('向后兼容：listSkills 排序稳定，ctx 为单一真相源', () => {
    registerSkill(makeDef('b'));
    registerSkill(makeDef('a'));
    expect(listSkills().map((s) => s.id)).toEqual(['a', 'b']);
  });
});
