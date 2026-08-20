/**
 * src/engine/experience/capsuleToItemBank.ts
 * 群体胶囊 → 题库进化接线（让题目从真实任务自发生长）。
 *
 * 设计理念（见 benchmark-research-2026-08-19.md §四.3）：
 * 群体胶囊的 taskType/approvalRate/avgRework 信号触发题库进化：
 *   - 某题高频返工 → 难度上调（params.b +）
 *   - 某题 approvalRate 极低 → 标记需同义克隆重写（触发 itemBank.cloneItem）
 *   - 某题 approvalRate 极高 + 低返工 → 难度下调（params.b -）
 *   - 新工作流模式涌现（taskType 在胶囊池高频出现但题库无对应题）→ 标记需新增题
 *   - 低区分度（approvalRate 接近随机 0.5）→ 标记加 canary 巡检
 *
 * 本模块纯函数：从胶囊信号推导题库进化动作，不直接改 ItemSpec
 * （调用方拿到动作后自己决定是否 apply，保持 best-effort）。
 *
 * 纯函数、零外部依赖、可单测。与 itemBank.cloneItem / benchmarkRef.classifyTaskType 接通。
 */
import type { ExperienceCapsule } from '@/types/capsule';
import type { ItemSpec, ItemParams } from '@/engine/interview/itemBank';
import { classifyTaskType, type TaskType } from '@/engine/interview/benchmarkRef';

/** 单题的进化信号（由胶囊池聚合而来） */
export interface ItemEvolutionSignal {
  /** 对应题 id（与 ItemSpec.id 对齐） */
  itemId: string;
  /** 任务类型（由胶囊 taskText/jobType 经 classifyTaskType 推导） */
  taskType: TaskType;
  /** 样本数 */
  sampleSize: number;
  /** 通过率 0–1 */
  approvalRate: number;
  /** 平均返工轮数 */
  avgRework: number;
  /** 平均用户契合度（可选） */
  avgUserFit?: number | null;
}

/** 进化动作类型 */
export type EvolutionActionKind =
  | 'clone'
  | 'raise-difficulty'
  | 'lower-difficulty'
  | 'add-canary'
  | 'add-new-item'
  | 'no-op';

/** 进化动作 */
export interface EvolutionAction {
  itemId: string;
  action: EvolutionActionKind;
  reason: string;
  /** 难度调整的 delta（raise/lower 用） */
  difficultyDelta?: number;
  /** 新题的任务类型（add-new-item 用） */
  newTaskType?: TaskType;
}

/** 阈值（可调，纯函数参数化） */
export interface EvolutionThresholds {
  /** 启用进化的最小样本数（不足则 no-op，诚实化） */
  minSamples: number;
  /** approvalRate 低于此 → clone（题被高频做错，需重写） */
  cloneApprovalThreshold: number;
  /** approvalRate 高于此 + 低返工 → lower-difficulty（题太易） */
  easyApprovalThreshold: number;
  /** avgRework 高于此 → raise-difficulty（题难） */
  hardReworkThreshold: number;
  /** approvalRate 在 [0.45, 0.55] → add-canary（区分度低，疑似背题） */
  lowDiscriminationLow: number;
  lowDiscriminationHigh: number;
}

export const DEFAULT_EVOLUTION_THRESHOLDS: EvolutionThresholds = {
  minSamples: 3,
  cloneApprovalThreshold: 0.3,
  easyApprovalThreshold: 0.85,
  hardReworkThreshold: 1.5,
  lowDiscriminationLow: 0.45,
  lowDiscriminationHigh: 0.55,
};

/**
 * 从单题进化信号推导进化动作（纯函数）。
 *
 * 优先级（从最严重到最轻）：
 * 1. 样本不足 → no-op（诚实化，不编造）
 * 2. approvalRate < clone 阈值 → clone（题被高频做错，需同义克隆重写）
 * 3. approvalRate 在低区分度区间 → add-canary（疑似背题，加巡检）
 * 4. avgRework > hard 阈值 → raise-difficulty（+0.3）
 * 5. approvalRate > easy 阈值 & avgRework 低 → lower-difficulty（-0.3）
 * 6. 其余 → no-op
 */
export function deriveEvolutionAction(
  signal: ItemEvolutionSignal,
  thresholds: EvolutionThresholds = DEFAULT_EVOLUTION_THRESHOLDS,
): EvolutionAction {
  const { itemId, taskType, sampleSize, approvalRate, avgRework } = signal;
  const base = { itemId, taskType };

  if (sampleSize < thresholds.minSamples) {
    return { ...base, action: 'no-op', reason: `样本不足（${sampleSize}<${thresholds.minSamples}），不编造进化` };
  }
  if (approvalRate < thresholds.cloneApprovalThreshold) {
    return { ...base, action: 'clone', reason: `approvalRate=${approvalRate.toFixed(2)} < ${thresholds.cloneApprovalThreshold}，题被高频做错，触发同义克隆重写` };
  }
  if (
    approvalRate >= thresholds.lowDiscriminationLow &&
    approvalRate <= thresholds.lowDiscriminationHigh
  ) {
    return { ...base, action: 'add-canary', reason: `approvalRate=${approvalRate.toFixed(2)} 落在低区分度区间，疑似背题，加 canary 巡检` };
  }
  if (avgRework > thresholds.hardReworkThreshold) {
    return {
      ...base,
      action: 'raise-difficulty',
      reason: `avgRework=${avgRework.toFixed(2)} > ${thresholds.hardReworkThreshold}，题偏难，上调难度`,
      difficultyDelta: 0.3,
    };
  }
  if (approvalRate > thresholds.easyApprovalThreshold && avgRework < 0.5) {
    return {
      ...base,
      action: 'lower-difficulty',
      reason: `approvalRate=${approvalRate.toFixed(2)} > ${thresholds.easyApprovalThreshold} & avgRework=${avgRework.toFixed(2)} 低，题偏易，下调难度`,
      difficultyDelta: -0.3,
    };
  }
  return { ...base, action: 'no-op', reason: '指标在正常区间，无需进化' };
}

/**
 * 应用进化动作到 ItemSpec（纯函数，返回新 ItemSpec，不修改原对象）。
 * clone/add-canary/add-new-item 不在此 apply（需 cloneItem / canaryProbe，调用方自行调）；
 * 本函数只 apply 难度调整（raise/lower）。
 */
export function applyDifficultyAdjustment(
  item: ItemSpec,
  action: EvolutionAction,
): ItemSpec {
  if (action.action !== 'raise-difficulty' && action.action !== 'lower-difficulty') {
    return item;
  }
  const delta = action.difficultyDelta ?? 0;
  if (!Number.isFinite(delta) || delta === 0) return item;
  const currentParams: ItemParams = item.params ?? { a: 1, b: 0, c: 0 };
  const newB = Math.max(-3, Math.min(3, currentParams.b + delta));
  return {
    ...item,
    params: { ...currentParams, b: newB },
  };
}

/**
 * 从胶囊池聚合某题的进化信号（纯函数）。
 * 按 itemId 聚合 capsule，计算 sampleSize/approvalRate/avgRework/avgUserFit。
 * 胶囊需带 itemId（或通过 taskTitle 关联，简化版用 itemId 字段）。
 */
export function aggregateItemSignal(
  capsules: ExperienceCapsule[],
  itemId: string,
): ItemEvolutionSignal | null {
  const matching = capsules.filter((c) => (c as ExperienceCapsule & { itemId?: string }).itemId === itemId);
  if (matching.length === 0) return null;
  const approved = matching.filter((c) => c.approved === true).length;
  const reworkSum = matching.reduce((s, c) => s + (c.reworkRounds ?? 0), 0);
  const fitCaps = matching.filter((c) => typeof c.userFit === 'number');
  const fitSum = fitCaps.reduce((s, c) => s + (c.userFit ?? 0), 0);
  const taskType = classifyTaskType({
    jobType: matching[0].jobType ?? null,
    taskText: matching[0].taskTitle,
  });
  return {
    itemId,
    taskType,
    sampleSize: matching.length,
    approvalRate: approved / matching.length,
    avgRework: reworkSum / matching.length,
    avgUserFit: fitCaps.length > 0 ? fitSum / fitCaps.length : null,
  };
}

/**
 * 检测题库缺失的任务类型（胶囊池高频出现但题库无对应题）。
 * 返回需新增题的 taskType 列表。
 */
export function detectMissingTaskTypes(
  capsules: ExperienceCapsule[],
  items: ItemSpec[],
  minSamplesForNew: number = 5,
): TaskType[] {
  // 胶囊池按 taskType 聚类
  const typeCounts = new Map<TaskType, number>();
  for (const c of capsules) {
    const tt = classifyTaskType({
      jobType: c.jobType ?? null,
      taskText: c.taskTitle,
    });
    typeCounts.set(tt, (typeCounts.get(tt) ?? 0) + 1);
  }
  // 题库已有的 taskType（简化：用 item.stem 关键词推断，或 item.id 前缀）
  const existingTypes = new Set<TaskType>();
  for (const item of items) {
    const tt = classifyTaskType({
      jobType: item.jobType ?? null,
      taskText: item.stem,
    });
    existingTypes.add(tt);
  }
  const missing: TaskType[] = [];
  for (const [tt, count] of typeCounts) {
    if (count >= minSamplesForNew && !existingTypes.has(tt) && tt !== 'unknown' && tt !== 'single-turn') {
      missing.push(tt);
    }
  }
  return missing;
}
