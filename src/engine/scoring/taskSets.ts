/**
 * src/engine/scoring/taskSets.ts
 * Task-Set 可插拔（T9 前端镜像，与 model-service/app/scoring/task_sets.py 同义）。
 *
 * 零新增依赖（纯 TS）。后端为权威实现，前端提供轻量镜像供未来任务集 UI 选择。
 */
import type { JobType, TaskRunResult, TaskSetMeta } from '../../types/evaluation';

/** TaskSet 抽象（管线无关，仅产出标准化 TaskRunResult）。 */
export interface TaskSet {
  id: string;
  title: string;
  description: string;
  applicableJobs: JobType[];
  /** 运行任务集（真实调度由后端承担；前端镜像仅声明契约）。 */
  run?: (input: unknown, opts?: { repeats?: number }) => Promise<TaskRunResult>;
}

/** TaskSet 注册表（前端镜像，预留未来任务集 UI 选择）。 */
export class TaskSetRegistry {
  private registry: Map<string, TaskSet> = new Map();

  register(ts: TaskSet): void {
    this.registry.set(ts.id, ts);
  }

  get(id: string): TaskSet | undefined {
    return this.registry.get(id);
  }

  list(): TaskSet[] {
    return Array.from(this.registry.values());
  }
}

/** 内置 TaskSet 元数据镜像（与后端 UsageEfficiencyTaskSet 对齐）。 */
export const USAGE_EFFICIENCY_META: TaskSetMeta = {
  id: 'usage_efficiency',
  title: 'Usage Efficiency',
  description:
    '复用 /api/evaluate-run 语义：基于真实 token 用量与 transcript 派生客观分，' +
    '衡量 agent 在「又快又省 token（性价比）」约束下的产出质量。',
  applicableJobs: ['image', 'text', 'code'],
};

const _registry = new TaskSetRegistry();
_registry.register({
  id: USAGE_EFFICIENCY_META.id,
  title: USAGE_EFFICIENCY_META.title,
  description: USAGE_EFFICIENCY_META.description,
  applicableJobs: USAGE_EFFICIENCY_META.applicableJobs,
});

export function getTaskSet(id: string): TaskSet | undefined {
  return _registry.get(id);
}

export function listTaskSets(): TaskSet[] {
  return _registry.list();
}

export const taskSetRegistry = _registry;
