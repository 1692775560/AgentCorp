/**
 * tests/unit/plugins/roleCardPlugin.test.ts —— 角色卡插件验证
 * 验证 roleCardPlugin.apply(ctx) 把角色卡 Skill 投影注册进内核，且返回的 Disposable
 * 可整体卸载。仅依赖内核 + roleCard/handlers（不引入仓库级缺失符号外的额外耦合）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ctx } from '@/demo/plugins/context';
import { listSkills, resetSkills, getSkill } from '@/demo/skills/registry';
import { roleCardPlugin } from '@/demo/plugins/roleCardPlugin';

describe('roleCard plugin', () => {
  beforeEach(() => resetSkills());

  it('apply 把角色卡 Skill 投影注册进内核，dispose 全部卸载（unwind）', () => {
    const disp = roleCardPlugin.apply(ctx);
    const ids = listSkills().map((s) => s.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain('agent_interview');
    expect(ids).toContain('capability_assessment');
    expect(ids).toContain('reliability_audit');
    // 卸载插件 → 所有经本插件注册的 Skill 全部消失
    disp.dispose();
    expect(getSkill('agent_interview')).toBeUndefined();
    expect(getSkill('capability_assessment')).toBeUndefined();
  });
});
