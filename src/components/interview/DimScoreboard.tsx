/**
 * src/components/interview/DimScoreboard.tsx
 * 维度覆盖看板（模块 B · 设计 §4.2）—— 「对话式收敛」的进度条。
 *
 * 语义：面试开场时所有考查维度证据为空（高熵），每问一轮 dimTracker 就把
 * 回答的证据强度累加到对应维度上，看板整体填满即代表「模糊认知 → 可量化评估」
 * 的收敛完成度。红色/黄色条 = 证据缺口，直接对应右侧的追问建议。
 *
 * 纯展示组件：数据来自 dimTracker.computeCoverage，不持有任何状态。
 */
import { Target } from 'lucide-react';

import { Progress } from '@/components/ui/progress';
import type { DimCoverage } from '@/engine/interview/dimTracker';

interface DimScoreboardProps {
  /** 逐维覆盖度（dimTracker.computeCoverage 产出） */
  coverage: DimCoverage[];
  /** 整体覆盖比 0–1（dimTracker.coverageRatio 产出） */
  ratio: number;
  /** 已完成轮次（展示用） */
  turnCount?: number;
}

/** 覆盖度 → 条形颜色（缺口高亮，引导 HR 去补证据） */
function barColor(coverage: number): string {
  if (coverage >= 0.8) return 'bg-emerald-500';
  if (coverage >= 0.5) return 'bg-[#FFD233]';
  if (coverage > 0) return 'bg-orange-400';
  return 'bg-muted-foreground/30';
}

/** 覆盖度 → 中文状态词 */
function coverageLabel(coverage: number): string {
  if (coverage >= 0.8) return '证据充分';
  if (coverage >= 0.5) return '证据偏薄';
  if (coverage > 0) return '仅有片段';
  return '尚无证据';
}

export function DimScoreboard({ coverage, ratio, turnCount = 0 }: DimScoreboardProps) {
  const percent = Math.round(ratio * 100);
  const covered = coverage.filter((item) => item.coverage >= 0.8).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Target className="h-4 w-4 text-[#FFD233]" />
          维度覆盖 · 收敛进度
        </h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {covered}/{coverage.length} 维达标 · {turnCount} 轮
        </span>
      </div>

      {/* 总进度：熵下降的单值刻度 */}
      <div className="space-y-1">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">整体证据覆盖</span>
          <span className="text-lg font-bold tabular-nums text-foreground">{percent}%</span>
        </div>
        <Progress value={percent} className="h-2" />
      </div>

      {coverage.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          尚未开始面试，题序生成后此处显示考查维度。
        </p>
      ) : (
        <ul className="space-y-2">
          {coverage.map((item) => {
            const pct = Math.round(item.coverage * 100);
            return (
              <li key={item.dim} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-medium text-foreground" title={item.dim}>
                    {item.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {item.answered}/{item.asked} 轮
                    {typeof item.rating === 'number' ? ` · HR ${item.rating.toFixed(1)}` : ''}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className={`h-full rounded-full transition-all ${barColor(item.coverage)}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{coverageLabel(item.coverage)}</span>
                  <span className="tabular-nums">{pct}%</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
