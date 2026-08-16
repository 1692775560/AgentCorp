/**
 * 经验沉淀 Store
 * --------------------------------------------------------------------------
 * boss_review 产出的结构化 `precipitatedRule` 不再跑完即丢：
 * 每次闭环决策后写入本 Store，下一次闭环在 context 阶段读回并注入
 * interviewer/evaluator 上下文（如把「训练重点」作为追问提示），
 * 闭合「沉淀 → 复用为 Skill 输入」的回路。
 *
 * 持久化可插拔：默认内存 Map（web demo / vitest 直接可用）；
 * Electron 侧可注入 JSONL 落盘 persister（~/.openclaw 风格），浏览器侧可注入
 * localStorage persister——存储介质不影响存取语义。
 */
import type { PrecipitatedRule } from './handlers';

/** 一条沉淀记录：规则 + 所属候选 + 产出时间。 */
export interface ExperienceRecord {
  candidateId: string;
  rule: PrecipitatedRule;
  ts: number;
}

/** 可插拔持久化后端（JSONL 落盘 / localStorage / 内存均可实现此接口）。 */
export interface ExperiencePersister {
  append(record: ExperienceRecord): void;
  readAll(): ExperienceRecord[];
  clear(): void;
}

/** 默认内存持久化（零副作用，web/node/test 通用）。 */
export function createMemoryPersister(): ExperiencePersister {
  const records: ExperienceRecord[] = [];
  return {
    append: (r) => {
      records.push(r);
    },
    readAll: () => [...records],
    clear: () => {
      records.length = 0;
    },
  };
}

/**
 * 浏览器 localStorage 持久化（web demo 用）。
 *
 * 为什么需要它：默认内存 persister 在页面刷新后清零，会让「经验沉淀 → 下一轮复用」
 * 这条回路会退化为「同一次页面会话内才成立」：刷新页面后再跑，
 * 就看不到「已注入历史经验规则」。本后端把沉淀落到 localStorage，跨会话可复用。
 *
 * 非浏览器环境（vitest / node）自动降级为内存后端，语义不变。
 * 写入失败（隐私模式 / 配额超限）静默降级为内存，不阻断闭环主流程——
 * 经验沉淀是旁路能力，不该让它拖垮决策链路。
 */
export function createLocalStorageExperiencePersister(
  storageKey = 'agentcorp-experience',
): ExperiencePersister {
  const memory = createMemoryPersister();
  if (typeof localStorage === 'undefined') return memory;

  const readAll = (): ExperienceRecord[] => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      // 存储损坏按「无沉淀」处理，不抛错（trace/经验均为旁路证据）
      return Array.isArray(parsed) ? (parsed as ExperienceRecord[]) : [];
    } catch {
      return [];
    }
  };

  return {
    append: (record) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify([...readAll(), record]));
      } catch {
        memory.append(record); // 配额/隐私模式 → 退回内存，本次会话内仍可复用
      }
    },
    readAll: () => {
      const persisted = readAll();
      return persisted.length > 0 ? persisted : memory.readAll();
    },
    clear: () => {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // 忽略：清不掉也不影响后续读写语义
      }
      memory.clear();
    },
  };
}

let persister: ExperiencePersister = createMemoryPersister();

/** 替换持久化后端（Electron JSONL / 浏览器 localStorage 在各自侧注入）。 */
export function setExperiencePersister(p: ExperiencePersister): void {
  persister = p;
}

/** 写入一条经验规则（boss_review 决策后调用）。 */
export function saveRule(candidateId: string, rule: PrecipitatedRule): void {
  persister.append({ candidateId, rule, ts: Date.now() });
}

/** 读取经验规则；传 candidateId 时只看该候选的沉淀。 */
export function loadRules(candidateId?: string): ExperienceRecord[] {
  const all = persister.readAll();
  return candidateId ? all.filter((r) => r.candidateId === candidateId) : all;
}

/**
 * 取最近一条经验规则，供下一次闭环注入。
 * 传 candidateId 时**只**看该候选的沉淀（不做跨候选兜底——
 * 把别的候选的规则注入当前候选属于错配，review H3）；不传时返回全局最近。
 */
export function latestRule(candidateId?: string): PrecipitatedRule | null {
  if (candidateId !== undefined) {
    const mine = loadRules(candidateId);
    return mine.length > 0 ? mine[mine.length - 1]!.rule : null;
  }
  const all = loadRules();
  return all.length > 0 ? all[all.length - 1]!.rule : null;
}

/** 清空（仅测试用）。 */
export function clearRules(): void {
  persister.clear();
}
