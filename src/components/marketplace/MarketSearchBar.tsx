/**
 * src/components/marketplace/MarketSearchBar.tsx
 * 人才市集统一搜索区。
 *
 * 合并了原先分离的 TaskRequirementBar（自然语言需求 + 工种 + 排序）与页面内
 * 联的关键词搜索 / 标签筛选 / 雇佣形态切换，避免「两个输入框、两组筛选器」
 * 的重复认知负担。
 *
 * 层次：
 *   第一行  需求输入（自然语言，驱动 taskMatch 画像与匹配排序）+ 工种 + 排序
 *   第二行  雇佣形态（全部 / 团队 / 员工）+ 高级筛选开关
 *   展开区  关键词、标签、六维能力门槛（默认收起）
 *   末行    需求画像 chips（仅在有需求文本或解析结果时出现）
 */
import { useState } from 'react';
import { Wand2, Brain, RotateCcw, SlidersHorizontal, Search, X, Building2, User } from 'lucide-react';
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
import { RADAR_DIMS } from '@/engine/scoring/registry';
import type { JobType } from '@/types/evaluation';

const JOB_OPTIONS: Array<{ value: JobType | 'all'; label: string }> = [
  { value: 'all', label: '全部工种' },
  { value: 'image', label: '制图' },
  { value: 'text', label: '文案' },
  { value: 'code', label: '代码' },
];

const SORT_OPTIONS: MarketSortKey[] = ['match', 'review', 'budget', 'costperf'];

const TAG_OPTIONS = [
  '全部',
  '数据分析',
  '代码审查',
  '内容创作',
  'SOP',
  '客服',
  '翻译',
  '增长',
  '营销',
  '招聘',
];

export type HireTypeFilter = '全部' | '雇佣团队' | '雇佣员工';

const HIRE_TYPES: Array<Exclude<HireTypeFilter, '全部'>> = ['雇佣团队', '雇佣员工'];

const SELECT_CLASS =
  'h-11 rounded-full border border-gray-100 bg-white px-4 pr-9 text-sm font-bold text-[#1A1C1E] shadow-sm outline-none transition-colors focus:border-[#FFD233] focus:ring-2 focus:ring-[#FFD233]/20';

const PILL_ACTIVE = 'bg-[#1A1C1E] text-white shadow-md';
const PILL_IDLE =
  'border border-gray-100 bg-white text-gray-500 shadow-sm hover:bg-gray-50';

export interface MarketSearchBarProps {
  keyword: string;
  onKeywordChange: (value: string) => void;
  activeTag: string;
  onTagChange: (value: string) => void;
  hireType: HireTypeFilter;
  onHireTypeChange: (value: HireTypeFilter) => void;
  teamCount: number;
  singleCount: number;
}

export function MarketSearchBar({
  keyword,
  onKeywordChange,
  activeTag,
  onTagChange,
  hireType,
  onHireTypeChange,
  teamCount,
  singleCount,
}: MarketSearchBarProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const taskRequirement = useMarketplaceStore((s) => s.taskRequirement);
  const taskProfile = useMarketplaceStore((s) => s.taskProfile);
  const sortKey = useMarketplaceStore((s) => s.sortKey);
  const setTaskText = useMarketplaceStore((s) => s.setTaskText);
  const setJobType = useMarketplaceStore((s) => s.setJobType);
  const setSortKey = useMarketplaceStore((s) => s.setSortKey);
  const resetRequirement = useMarketplaceStore((s) => s.resetRequirement);
  const dimFilters = useMarketplaceStore((s) => s.dimFilters);
  const cycleDimFilter = useMarketplaceStore((s) => s.cycleDimFilter);
  const resetDimFilters = useMarketplaceStore((s) => s.resetDimFilters);
  const userWeight = useScoringStore((s) => s.userWeight);

  const deviations = weightDeviation(userWeight).slice(0, 2);
  const hasShift = deviations.some((d) => Math.abs(d.delta) >= 0.005);

  const dimActiveCount = RADAR_DIMS.filter((dim) => (dimFilters[dim] ?? 0) > 0).length;
  const advancedCount = dimActiveCount + (keyword ? 1 : 0) + (activeTag !== '全部' ? 1 : 0);

  return (
    <div className="rounded-[28px] border border-gray-100 bg-white/70 p-5 shadow-sm backdrop-blur-md">
      {/* 第一行：需求 + 工种 + 排序 + 心智权重 */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
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

        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  'flex h-11 shrink-0 cursor-help items-center gap-1.5 rounded-full px-4 text-xs font-bold transition-colors',
                  hasShift ? 'bg-[#1A1C1E] text-white' : 'border border-gray-100 bg-white text-gray-400',
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
                  当前与默认权重一致。去评估中心的「双榜」拖拽排序，市集排序会按你的口味变化。
                </p>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* 第二行：雇佣形态 + 高级筛选开关 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onHireTypeChange('全部')}
          className={cn(
            'rounded-full px-4 py-1.5 text-xs font-bold transition-all',
            hireType === '全部' ? 'bg-[#FFD233] text-[#1A1C1E] shadow-md' : PILL_IDLE,
          )}
        >
          全部类型
        </button>
        {HIRE_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => onHireTypeChange(type)}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-bold transition-all',
              hireType === type ? 'bg-[#FFD233] text-[#1A1C1E] shadow-md' : PILL_IDLE,
            )}
          >
            {type === '雇佣团队' ? <Building2 size={14} /> : <User size={14} />}
            {type}
            <span className="rounded-full bg-black/10 px-1.5 py-0.5 text-[10px] tabular-nums">
              {type === '雇佣团队' ? teamCount : singleCount}
            </span>
          </button>
        ))}

        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className={cn(
            'ml-auto flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-bold transition-all',
            advancedOpen || advancedCount > 0 ? PILL_ACTIVE : PILL_IDLE,
          )}
          aria-expanded={advancedOpen}
        >
          <SlidersHorizontal size={14} />
          高级筛选
          {advancedCount > 0 && (
            <span className="rounded-full bg-[#FFD233] px-1.5 py-0.5 text-[10px] tabular-nums text-[#1A1C1E]">
              {advancedCount}
            </span>
          )}
        </button>
      </div>

      {/* 展开区：关键词 + 标签 + 六维门槛 */}
      {advancedOpen && (
        <div className="mt-4 space-y-4 border-t border-gray-100 pt-4">
          <div className="relative max-w-md">
            <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={keyword}
              onChange={(e) => onKeywordChange(e.target.value)}
              placeholder="按名称或简介搜索 Agent"
              className="h-10 w-full rounded-full border border-gray-100 bg-white pl-10 pr-4 text-sm font-bold text-[#1A1C1E] shadow-sm placeholder:font-medium placeholder:text-gray-400 focus:border-[#FFD233] focus:outline-none focus:ring-2 focus:ring-[#FFD233]/20"
            />
          </div>

          <div>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400">
              擅长领域
            </p>
            <div className="flex flex-wrap gap-2">
              {TAG_OPTIONS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onTagChange(tag)}
                  className={cn(
                    'rounded-full px-3.5 py-1.5 text-xs font-bold transition-all',
                    activeTag === tag ? PILL_ACTIVE : PILL_IDLE,
                  )}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400">
              六维能力门槛
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {RADAR_DIMS.map((dim) => {
                const threshold = dimFilters[dim] ?? 0;
                const active = threshold > 0;
                return (
                  <button
                    key={dim}
                    type="button"
                    onClick={() => cycleDimFilter(dim)}
                    title={`点击提高 ${RADAR_DIM_LABELS[dim]} 门槛（0 → 3 → 3.5 → 4 → 4.5）`}
                    className={cn(
                      'rounded-full px-3.5 py-1.5 text-xs font-bold transition-all',
                      active ? PILL_ACTIVE : PILL_IDLE,
                    )}
                  >
                    {RADAR_DIM_LABELS[dim]}
                    {active && <span className="ml-1 text-[#FFD233]">≥{threshold}</span>}
                  </button>
                );
              })}
              {dimActiveCount > 0 && (
                <button
                  type="button"
                  onClick={resetDimFilters}
                  className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                >
                  <X size={12} />
                  清除门槛（{dimActiveCount}）
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 需求画像 */}
      {(taskProfile.tags.length > 0 || taskRequirement.text) && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
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

export default MarketSearchBar;
