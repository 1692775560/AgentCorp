/**
 * src/demo/plugins/context.ts  (Option 1 · T1)
 * --------------------------------------------------------------------------
 * 可逆注册内核（借 dsh "Everything is a Plugin" 范式，**自研**，不引任何第三方运行时，
 * 对齐 AGENTCORP_HARNESS §2 铁律）。
 *
 * 提供：
 *  - `PluginContext`：共享 ctx，向内核贡献 service / event / reversible effect
 *    （register 返回 Disposable、unregister、onDispose、on 订阅、applyPatch）。
 *  - `Disposable`：插件卸载句柄，dispose 时自动 unwind（注销定义 / 退订 event / 回滚 patch）。
 *  - `PluginPatch`：一行覆盖层（priority 越大越晚应用 = 覆盖优先级越高），对齐 cordis.patch.yml 单行语义。
 *  - `Plugin`：与 dsh `export function apply(ctx)` 同构的插件形态。
 *
 * registry.ts 的全部公共 API 委托给本内核的 `ctx` 单例，保证单一真相源、可释放、可 patch。
 */
import type { SkillDefinition } from '../skills/registry';

/** 可释放句柄：插件卸载时调用，触发 unwind（对齐 dsh 的 disposable）。 */
export interface Disposable {
  dispose(): void;
}

/** 一行 patch：覆盖某 Skill / 某 Provider / 某默认项（对齐 cordis.patch.yml 单行语义）。 */
export interface PluginPatch {
  priority: number;
  /** 'skill' | 'provider' | 'default' —— 覆盖目标类别。 */
  target: 'skill' | 'provider' | 'default';
  /** 目标 id（如 skill id / provider id）。 */
  id: string;
  /** 覆盖内容（与 target 同形状的局部对象，浅合并）。 */
  override: Record<string, unknown>;
}

/** 内核事件（session/event 与 agent/* waterfall 的可订阅雏形 发现广播复用）。 */
export interface PluginEvents {
  'agent/registered': { id: string; name: string };
  'skill/unregistered': { id: string };
}
export type PluginEventHandler<K extends keyof PluginEvents> = (payload: PluginEvents[K]) => void;

/** 能力 seam 类别（Option 1 · T5 LLM / T6 judge / 未来 tool / sandbox 活注册表衔接）。 */
export type CapabilityKind = 'llm' | 'judge' | 'tool' | 'sandbox';

/** 插件内核上下文：向共享 ctx 贡献 service / event / effect。 */
export interface PluginContext {
  /** 注册 Skill，返回 Disposable；dispose 时自动注销（unwind）。 */
  register(def: SkillDefinition): Disposable;
  /** 显式注销（等价于 dispose 该 Skill 的句柄）。 */
  unregister(id: string): boolean;
  /** 查询某 id 是否已注册（插件注册前自检，避免重复注册导致 dispose 错乱）。 */
  has(id: string): boolean;
  /** 注册卸载钩子（插件清理副作用用），返回可释放句柄。 */
  onDispose(fn: () => void): Disposable;
  /** 订阅 typed event（对齐 dsh session/event 与 agent/* waterfall）。 */
  on<K extends keyof PluginEvents>(type: K, handler: PluginEventHandler<K>): Disposable;
  /** 注册一行 patch 覆盖层；priority 越大越晚应用 = 覆盖优先级越高。 */
  applyPatch(patch: PluginPatch): Disposable;
}

/** 插件形态：与 dsh `export function apply(ctx)` 同构。 */
export interface Plugin {
  name: string;
  apply(ctx: PluginContext): void | Disposable;
}

type AnyHandler = (payload: unknown) => void;

/** 内核完整接口：PluginContext + registry.ts 委托所需的查询/管理 API。 */
export interface PluginKernel extends PluginContext {
  get(id: string): SkillDefinition | undefined;
  list(): SkillDefinition[];
  has(id: string): boolean;
  clear(): void;
  /** 能力 seam：注册某类能力的可替换 Provider（T5 LLM / T6 judge / 未来 tool / sandbox）。 */
  registerProvider(kind: CapabilityKind, id: string, impl: unknown, priority?: number): Disposable;
  /** 取指定 id 的 Provider（按 kind + id 精确查找）。 */
  getProvider<I = unknown>(kind: CapabilityKind, id: string): I | undefined;
  /** 取某类能力的默认 Provider（priority 最大者；并列取最后注册）。 */
  getDefaultProvider<I = unknown>(kind: CapabilityKind): I | undefined;
}

class SkillRegistry implements PluginKernel {
  /** 未打 patch 的原始定义（base）；registry 为叠加 patch 后的有效定义。 */
  private baseRegistry = new Map<string, SkillDefinition>();
  private registry = new Map<string, SkillDefinition>();
  private disposers = new Map<string, Array<() => void>>();
  private listeners = new Map<keyof PluginEvents, Set<AnyHandler>>();
  private patches: PluginPatch[] = [];
  private providers = new Map<CapabilityKind, Map<string, { impl: unknown; priority: number }>>();

  register(def: SkillDefinition): Disposable {
    const existed = this.registry.has(def.id);
    this.baseRegistry.set(def.id, def);
    this.registry.set(def.id, def);
    if (!existed) this.emit('agent/registered', { id: def.id, name: def.name });
    const unregister = this.unregister.bind(this);
    return { dispose: () => unregister(def.id) };
  }

  unregister(id: string): boolean {
    const had = this.registry.delete(id);
    this.baseRegistry.delete(id);
    this.disposers.get(id)?.forEach((fn) => fn());
    this.disposers.delete(id);
    if (had) this.emit('skill/unregistered', { id });
    return had;
  }

  onDispose(fn: () => void): Disposable {
    // 全局生命周期钩子（内核级）；返回可释放句柄。
    // 注：T1 阶段仅提供形态；持久化钩子列表为后续 G11 活注册表衔接预留。
    return { dispose: () => fn() };
  }

  on<K extends keyof PluginEvents>(type: K, handler: PluginEventHandler<K>): Disposable {
    const set = this.listeners.get(type) ?? new Set<AnyHandler>();
    set.add(handler as AnyHandler);
    this.listeners.set(type, set);
    const listeners = this.listeners;
    return { dispose: () => listeners.get(type)?.delete(handler as AnyHandler) };
  }

  applyPatch(patch: PluginPatch): Disposable {
    this.patches.push(patch);
    this.patches.sort((a, b) => a.priority - b.priority); // 高 priority 后应用 = 覆盖
    this.recompute(patch.id);
    const removePatch = this.removePatch.bind(this);
    return { dispose: () => removePatch(patch) };
  }

  /** 从 base 定义 + 当前所有 patch（按 priority 升序）重建某 id 的有效定义。 */
  private recompute(id: string): void {
    const base = this.baseRegistry.get(id);
    if (!base) return;
    let eff: SkillDefinition = base;
    for (const p of this.patches) {
      if (p.target === 'skill' && p.id === id) {
        eff = { ...eff, ...(p.override as Partial<SkillDefinition>) };
      }
    }
    this.registry.set(id, eff);
  }

  private removePatch(patch: PluginPatch): void {
    this.patches = this.patches.filter((p) => p !== patch);
    this.recompute(patch.id);
  }

  get(id: string): SkillDefinition | undefined {
    return this.registry.get(id);
  }
  list(): SkillDefinition[] {
    return [...this.registry.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  has(id: string): boolean {
    return this.registry.has(id);
  }

  registerProvider(kind: CapabilityKind, id: string, impl: unknown, priority = 0): Disposable {
    let m = this.providers.get(kind);
    if (!m) {
      m = new Map();
      this.providers.set(kind, m);
    }
    m.set(id, { impl, priority });
    const remove = this.removeProvider.bind(this);
    return { dispose: () => remove(kind, id) };
  }

  getProvider<I = unknown>(kind: CapabilityKind, id: string): I | undefined {
    const entry = this.providers.get(kind)?.get(id);
    return (entry?.impl as I) ?? undefined;
  }

  getDefaultProvider<I = unknown>(kind: CapabilityKind): I | undefined {
    const m = this.providers.get(kind);
    if (!m || m.size === 0) return undefined;
    let best: { impl: unknown; priority: number } | undefined;
    for (const v of m.values()) {
      if (!best || v.priority > best.priority) best = v;
    }
    return (best?.impl as I) ?? undefined;
  }

  private removeProvider(kind: CapabilityKind, id: string): void {
    this.providers.get(kind)?.delete(id);
  }

  clear(): void {
    this.baseRegistry.clear();
    this.registry.clear();
    this.disposers.clear();
    this.listeners.clear();
    this.patches = [];
    this.providers.clear();
  }

  private emit<K extends keyof PluginEvents>(type: K, payload: PluginEvents[K]): void {
    this.listeners.get(type)?.forEach((h) => h(payload));
  }
}

/** 内核单例（共享 ctx）。 */
export const ctx: PluginKernel = new SkillRegistry();
