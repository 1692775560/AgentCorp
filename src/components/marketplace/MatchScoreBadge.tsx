/**
 * src/components/marketplace/MatchScoreBadge.tsx
 * 匹配分徽章 + 四项分解 tooltip（模块 A）。
 *
 * 复用项目既有 Radix tooltip（src/components/ui/tooltip），零新增依赖。
 */
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { MatchScoreBreakdown } from '@/types/marketplace';

export interface MatchScoreBadgeProps {
  /** 匹配分解；缺省表示候选尚无六维（不参与匹配） */
  match?: MatchScoreBreakdown | null;
  className?: string;
}

/** 分档配色：≥75 优秀 / ≥55 良好 / 其余中性 */
function toneOf(total: number): string {
  if (total >= 75) return 'bg-emerald-50 text-emerald-600 ring-emerald-200';
  if (total >= 55) return 'bg-[#FFD233]/25 text-[#8a6d00] ring-[#FFD233]/50';
  return 'bg-gray-100 text-gray-500 ring-gray-200';
}

/** 单行分解条目 */
function BreakdownRow({
  label,
  value,
  weight,
  hint,
}: {
  label: string;
  value: number;
  weight: number;
  hint: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-[11px]">
      <span className="flex items-center gap-1 text-gray-500">
        {label}
        <span className="text-[10px] text-gray-400">×{weight}</span>
      </span>
      <span className="flex items-center gap-2">
        <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-gray-200">
          <span
            className="block h-full rounded-full bg-[#FFD233]"
            style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
          />
        </span>
        <span className="w-9 text-right font-bold text-[#1A1C1E]">
          {(value * 100).toFixed(0)}
        </span>
        <span className="sr-only">{hint}</span>
      </span>
    </div>
  );
}

export function MatchScoreBadge({ match, className }: MatchScoreBadgeProps) {
  if (!match) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-bold text-gray-400 ring-1 ring-gray-200',
          className,
        )}
      >
        待初审
      </span>
    );
  }

  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-flex cursor-help items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold ring-1',
              toneOf(match.total),
              className,
            )}
          >
            <Sparkles size={12} />
            匹配 {match.total.toFixed(0)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="w-60 bg-white p-3 shadow-xl">
          <p className="mb-2 text-xs font-bold text-[#1A1C1E]">
            匹配分解 · 总分 {match.total.toFixed(1)}
          </p>
          <div className="space-y-1.5">
            <BreakdownRow
              label="六维契合"
              value={match.userFit}
              weight={match.weights.fit}
              hint="心智权重 × 任务强调后的加权契合度"
            />
            <BreakdownRow
              label="标签契合"
              value={match.tagMatch}
              weight={match.weights.tag}
              hint="需求标签与候选标签的 Jaccard 相似度"
            />
            <BreakdownRow
              label="性价比"
              value={match.costPerf}
              weight={match.weights.cost}
              hint="能力均值 / 相对报价"
            />
            <BreakdownRow
              label="绩效回流"
              value={match.perfBoost}
              weight={match.weights.perf}
              hint="S3 绩效评分卡 total / 100，无绩效取 0.5 中性值"
            />
          </div>
          <p className="mt-2 border-t border-gray-100 pt-2 text-[10px] leading-relaxed text-gray-400">
            契合项已叠加你的心智权重（绩效双榜拖拽会实时改变这里的排序）
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default MatchScoreBadge;
