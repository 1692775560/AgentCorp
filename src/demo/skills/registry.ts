/**
 * Skill 运行时注册表（GOAI 要求 2 · SP-01）
 * --------------------------------------------------------------------------
 * 把 roleCard.ts 里仅作「数据声明」的 RoleCardSkill 升级为**可被 AgentTeams
 * 调用的 Skill 定义**：GOAI 赛题 2.1 全字段 + 可执行 handler + 注册表。
 *
 * 设计要点：
 *  - `SkillDefinition` 保留 2.1 全部字段（名称/用途/输入输出/调用条件/依赖/
 *    失败处理/安全边界/复用价值/协同关系），并追加 `ownerAgent` 与 `handler`。
 *  - handler 统一返回 `SkillResult`，**失败不抛**——异常在此层被捕获并降级为
 *    `{ ok:false, degraded:true }`，对应赛题「失败处理机制」要求。
 *  - 本模块零 Electron/IPC 副作用，可在 vitest 与 web demo 中直接运行。
 */
import type { RoleCard, RoleCardSkill } from '@/engine/agents/roleCard';

/** Skill 调用结果：失败降级语义内建（ok=false + degraded=true + reason）。 */
export interface SkillResult<T = unknown> {
  ok: boolean;
  /** true = 以降级路径产出（如 judge 不可用、依赖缺失），结果仍可用但需标注 */
  degraded: boolean;
  /** 失败/降级原因（人类可读） */
  reason?: string;
  data?: T;
}

/** Skill 处理器：任意 JSON 参数 → SkillResult，约定不抛出异常。 */
export type SkillHandler = (args: Record<string, unknown>) => Promise<SkillResult>;

/** GOAI 2.1 全字段 + 运行时绑定。 */
export interface SkillDefinition {
  id: string;
  name: string; // Skill 名称
  purpose: string; // 用途
  inputs: string; // 输入
  outputs: string; // 输出
  invokeCondition: string; // 调用条件
  dependsOn: string[]; // 依赖（Skill / MCP / 云产品 / 知识库）
  failureHandling: string; // 失败处理机制
  securityBoundary: string; // 安全边界
  reuseValue: string; // 复用价值
  collaboration: string; // 与多 Agent 协同流程的关系
  /** 拥有该 Skill 的 Agent（角色卡 id，如 boss / evaluator） */
  ownerAgent: string;
  /** 可执行入口 */
  handler: SkillHandler;
}

const registry = new Map<string, SkillDefinition>();

/** 注册 Skill（同 id 后注册覆盖先注册，便于 mock 替换真实 handler）。 */
export function registerSkill(def: SkillDefinition): void {
  registry.set(def.id, def);
}

/** 按 id 查询 Skill 定义。 */
export function getSkill(id: string): SkillDefinition | undefined {
  return registry.get(id);
}

/** 列出全部已注册 Skill（按 id 排序，输出稳定）。 */
export function listSkills(): SkillDefinition[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** 清空注册表（仅测试用）。 */
export function resetSkills(): void {
  registry.clear();
}

/**
 * 调用 Skill：查表 → 执行 handler → 异常兜底。
 * 任何失败（未注册 / handler 抛错 / handler 返回 ok=false）都不会抛出，
 * 保证编排层可以无条件串接 Skill 调用链。
 */
export async function runSkill(
  id: string,
  args: Record<string, unknown> = {},
): Promise<SkillResult> {
  const def = registry.get(id);
  if (!def) {
    return { ok: false, degraded: true, reason: `skill 未注册: ${id}` };
  }
  try {
    const result = await def.handler(args);
    return { ...result, degraded: result.degraded ?? !result.ok };
  } catch (err) {
    return {
      ok: false,
      degraded: true,
      reason: `skill ${id} 执行异常: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 把角色卡上的 RoleCardSkill 投影为 SkillDefinition（2.1 字段一一对应），
 * handler 由调用方绑定（真实实现见 handlers.ts，测试可注入 mock）。
 */
export function projectSkill(
  card: RoleCard,
  skill: RoleCardSkill,
  handler: SkillHandler,
): SkillDefinition {
  return {
    id: skill.id,
    name: skill.name,
    purpose: skill.purpose,
    inputs: skill.inputs,
    outputs: skill.outputs,
    invokeCondition: skill.invokeCondition,
    dependsOn: skill.dependsOn,
    failureHandling: skill.failureHandling,
    securityBoundary: skill.securityBoundary,
    reuseValue: skill.reuseValue,
    collaboration: skill.collaboration,
    ownerAgent: card.id,
    handler,
  };
}
