/**
 * src/components/interview/FollowupSuggestChips.tsx
 * 追问建议芯片（模块 B · 设计 §4.2）—— 「对话式收敛」的方向盘。
 *
 * dimTracker 每轮重算逐维证据覆盖，把最薄弱的 ≥2 个维度包装成可一键发问的
 * 追问题。HR 点一下即把当前题替换成只考查该维的追问题，让下一轮回答精准
 * 落在证据缺口上——这就是「用对话把高熵认知逼向低熵」的具体操作面。
 *
 * 纯展示组件：建议来自 dimTracker.suggestFollowups，点击回调交给上层 store。
 */
import { Lightbulb, Plus } from 'lucide-react';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { FollowupSuggestion } from '@/engine/interview/dimTracker';

interface FollowupSuggestChipsProps {
  /** 追问建议列表（覆盖度最薄弱的维度优先） */
  suggestions: FollowupSuggestion[];
  /** 采纳建议：生成追问题并设为当前题 */
  onApply: (suggestion: FollowupSuggestion) => void;
  /** 面试未开始 / 已结束时禁用 */
  disabled?: boolean;
}

export function FollowupSuggestChips({
  suggestions,
  onApply,
  disabled = false,
}: FollowupSuggestChipsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Lightbulb className="h-3.5 w-3.5 text-[#FFD233]" />
        证据缺口 · 建议追问
      </div>
      <TooltipProvider delayDuration={200}>
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((item) => (
            <Tooltip key={`${item.dim}-${item.prompt.slice(0, 12)}`}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onApply(item)}
                  className="group inline-flex max-w-full items-center gap-1 rounded-full border border-[#FFD233]/50 bg-[#FFD233]/10 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-[#FFD233]/25 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus className="h-3 w-3 shrink-0 text-[#FFD233]" />
                  <span className="truncate">追问「{item.label}」</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="text-xs font-medium">{item.reason}</p>
                <p className="mt-1 text-xs text-muted-foreground">{item.prompt}</p>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>
    </div>
  );
}
