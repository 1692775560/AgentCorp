/**
 * src/demo/plugins/roleCardPlugin.ts  (Option 1 · T4)
 * --------------------------------------------------------------------------
 * roleCard 即插件：把 4 张角色卡上的 RoleCardSkill 投影为 SkillDefinition，
 * 经内核 ctx.register 注册（与 dsh「插件向共享 ctx 贡献 service」同构）。
 *
 * handler 实现来自 handlers.ts 的 BUILTIN_HANDLERS（真实的 Skill handler）。
 * 本文件【单向】依赖 handlers（handlers 不反向 import 本文件），因此无模块初始化环；
 * 内核（T1-T3）保证注册可释放、可 patch。
 *
 * 与现有 registerBuiltinSkills() 的关系：两者都基于 BUILTIN_HANDLERS 投影注册，
 * 当前并存；待迁到绿色分支（fix/code-health-g8-g10）后，可让 registerBuiltinSkills
 * 直接委托本插件作为单一注册入口（消除重复）。
 */
import type { Plugin } from './context';
import { projectSkill } from '../skills/registry';
import { ROLE_CARDS } from '@/engine/agents/roleCard';
import { BUILTIN_HANDLERS } from '../skills/handlers';

export const roleCardPlugin: Plugin = {
  name: 'role-card',
  apply(kernel) {
    const disposers: Array<() => void> = [];
    for (const card of ROLE_CARDS) {
      for (const skill of card.skills) {
        const handler = BUILTIN_HANDLERS[skill.id as keyof typeof BUILTIN_HANDLERS];
        if (handler && !kernel.has(skill.id)) {
          disposers.push(kernel.register(projectSkill(card, skill, handler)).dispose);
        }
      }
    }
    return {
      dispose: () => {
        for (const d of disposers) d();
      },
    };
  },
};
