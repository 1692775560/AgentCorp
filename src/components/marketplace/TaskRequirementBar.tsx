/**
 * src/components/marketplace/TaskRequirementBar.tsx
 * 任务需求输入条（模块 A）。
 *
 * 三件事：
 * 1. 自然语言需求输入 → `taskMatch` 确定性词典解析出任务画像（工种 / 维度强调 / 标签）；
 * 2. 工种与排序方式选择；
 * 3. 「心智偏移」指示：展示当前 userWeight 相对默认权重的 top-2 偏移，
 *    证明绩效双榜拖拽的回灌确实作用到了市场排序上。
 */
import { Wand2, Brain, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useMarketplaceStore, SORT_KEY_LABELS, type MarketSortKey } from '@/stores/marketplace';
import { useScoringStore } from '@/stores/scoringStore';
import { weightDeviation } from '@/engine/marketplace/userFit';
import { RADAR_DIM_LABELS } from '@/engine/marketplace/radarSource';
import type { JobType } from '@/types/evaluation';

/** 工种选项（含「不限」） */
const JOB_OPTIONS: Array<{ value: JobType | 'all'; label: string }> = [
  { value: 'all', label: '全部工种' },
  { value: 'image', label: '制图' },
  { value: 'text', label: '文案' },
  { value: 'code', label: '代码' },
];

const SORT_OPTIONS: MarketSortKey[] = ['match', 'review', 'budget', 'costperf'];

const SELECT_CLASS =
  'h-11 rounded-full border border-gray-100 bg-white px-4 pr-9 text-sm font-bold text-[#1A1C1E] shadow-sm outline-none transition-colors focus:border-[#FFD233] focus:ring-2 focus:ring-[#FFD233]/20';

export function TaskRequirementBar() {
  const taskRequirement = useMarketplaceStore((s) => s.taskRequirement);
  const taskProfile = useMarketplaceStore((s) => s.taskProfile);
  const sortKey = useMarketplaceStore((s) => s.sortKey);
  const setTaskText = useMarketplaceStore((s) => s.setTaskText);
  const setJobType = useMarketplaceStore((s) => s.setJobType);
  const setSortKey = useMarketplaceStore((s) => s.setSortKey);
  const resetRequirement = useMarketplaceStore((s) => s.resetRequirement);
  const userWeight = useScoringStore((s) => s.userWeight);

  // 心智偏移 top-2（绝对值最大的两维）
  const deviations = weightDeviation(userWeight).slice(0, 2);
  const hasShift = deviations.some((d) => Math.abs(d.delta) >= 0.005);

  return (
    <div className="rounded-[28px] border border-gray-100 bg-white/70 p-5 shadow-sm backdrop-blur-md">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        {/* 需求文本 */}
        <div className="relative flex-1">
          <Wand2 className="absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[#FFD233]" />
          <input
            type="text"
            value={taskRequirement.text}
            onChange={(e) => setTaskText(e.target.value)}
            placeholder="描述你的任务需求，例如：要一个稳定又便宜的后端 agent"
            className="h-11 w-full rounded-full border border-gray-100 bg-white pl-11 pr-4 text-sm font-bold text-[#1A1C1E] shadow-sm placeholder:font-medium placeholder:text-gray-400 focus:border-[#FFD233] focus:outline-none focus:ring-2 focus:ring-[#FFD233]/20"
          />
        </div>

        {/* 工种 */}
        <select
          value={taskRequirement.jobType}
          onChange={(e) => setJobType(e.target.value as JobType | 'all')}
          className={SELECT_CLASS}
          aria-label="期望工种"
        >
          {JOB_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        {/* 排序 */}
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as MarketSortKey)}
          className={SELECT_CLASS}
          aria-label="排序方式"
        >
          {SORT_OPTIONS.map((key) => (
            <option key={key} value={key}>
              按{SORT_KEY_LABELS[key]}
            </option>
          ))}
        </select>

        {/* 心智权重指示 */}
        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  'flex h-11 shrink-0 cursor-help items-center gap-1.5 rounded-full px-4 text-xs font-bold transition-colors',
                  hasShift
                    ? 'bg-[#1A1C1E] text-white'
                    : 'border border-gray-100 bg-white text-gray-400',
                )}
              >
                <Brain size={14} />
                心智权重
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="w-64 bg-white p-3 shadow-xl">
              <p className="mb-2 text-xs font-bold text-[#1A1C1E]">你的心智权重偏移</p>
              {hasShift ? (
                <div className="space-y-1">
                  {deviations.map((d) => (
                    <p key={d.dim} className="flex justify-between text-[11px] text-gray-500">
                      <span>{RADAR_DIM_LABELS[d.dim]}</span>
                      <span
                        className={cn(
                          'font-bold',
                          d.delta >= 0 ? 'text-emerald-600' : 'text-rose-500',
                        )}
                      >
                        {d.delta >= 0 ? '+' : ''}
                        {(d.delta * 100).toFixed(1)}%
                      </span>
                    </p>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-gray-400">
                  当前与默认权重一致。去绩效考核页拖拽双榜，排序会按你的口味变化。
                </p>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* 派生画像展示 */}
      {(taskProfile.tags.length > 0 || taskRequirement.text) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400">
            需求画像
          </span>
          {taskProfile.jobType && (
            <span className="rounded-full bg-[#1A1C1E] px-2.5 py-1 text-[10px] font-bold text-white">
              工种 · {JOB_OPTIONS.find((o) => o.value === taskProfile.jobType)?.label}
            </span>
          )}
          {taskProfile.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-[#FFD233]/25 px-2.5 py-1 text-[10px] font-bold text-[#8a6d00]"
            >
              {tag}
            </span>
          ))}
          {Object.entries(taskProfile.dimBoost).map(([dim, factor]) => (
            <span
              key={dim}
              className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-600"
            >
              {RADAR_DIM_LABELS[dim as keyof typeof RADAR_DIM_LABELS]} ×{factor}
            </span>
          ))}
          {taskRequirement.text && (
            <button
              type="button"
              onClick={resetRequirement}
              className="ml-auto flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            >
              <RotateCcw size={12} />
              清空需求
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default TaskRequirementBar;
