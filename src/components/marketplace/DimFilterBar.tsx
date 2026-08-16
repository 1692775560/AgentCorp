/**
 * src/components/marketplace/DimFilterBar.tsx
 * 六维能力阈值筛选条（模块 A）。
 *
 * 每个维度一个 chip，点击循环阈值 0 → 3 → 3.5 → 4 → 4.5 → 0；
 * 阈值 > 0 即硬过滤（候选该维必须 ≥ 阈值；无六维的候选被过滤掉）。
 */
import { SlidersHorizontal, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMarketplaceStore } from '@/stores/marketplace';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import { RADAR_DIM_LABELS } from '@/engine/marketplace/radarSource';

export function DimFilterBar() {
  const dimFilters = useMarketplaceStore((s) => s.dimFilters);
  const cycleDimFilter = useMarketplaceStore((s) => s.cycleDimFilter);
  const resetDimFilters = useMarketplaceStore((s) => s.resetDimFilters);

  const activeCount = RADAR_DIMS.filter((dim) => (dimFilters[dim] ?? 0) > 0).length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1.5 text-xs font-bold text-gray-400">
        <SlidersHorizontal size={14} />
        能力门槛
      </span>
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
              active
                ? 'bg-[#1A1C1E] text-white shadow-md'
                : 'border border-gray-100 bg-white text-gray-500 shadow-sm hover:bg-gray-50',
            )}
          >
            {RADAR_DIM_LABELS[dim]}
            {active && <span className="ml-1 text-[#FFD233]">≥{threshold}</span>}
          </button>
        );
      })}
      {activeCount > 0 && (
        <button
          type="button"
          onClick={resetDimFilters}
          className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          <X size={12} />
          清除门槛（{activeCount}）
        </button>
      )}
    </div>
  );
}

export default DimFilterBar;
