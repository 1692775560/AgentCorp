/**
 * src/components/interview/InterviewBubble.tsx
 * 单轮问答气泡（模块 B · 设计 §4.2）。
 *
 * 一轮 = 「题干（考查维度）→ 候选回答 → HR 逐维打分 + 证据备注」。
 * 打分不是走过场：hrRatings 会被 dimTracker.aggregateHrRadar 聚合成 finalRadar，
 * 进而成为 S2 评分卡与绩效基线的输入（★通道②的源头数据）。
 *
 * 纯受控组件：不持有面试状态，全部通过回调上抛。
 */
import { useState } from 'react';
import { ChevronDown, ChevronUp, Clock, Coins, MessageSquareQuote, User2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { RADAR_DIMS, craftLinks } from '@/engine/scoring/registry';
import { RADAR_DIM_LABELS } from '@/engine/marketplace/radarSource';
import { dimLabel } from '@/engine/interview/dimTracker';
import type { InterviewTurn } from '@/types/interview';
import type { RadarDim } from '@/types/evaluation';

interface InterviewBubbleProps {
  turn: InterviewTurn;
  /** HR 逐维打分（0–5，0.5 步进） */
  onRate: (turn: number, dim: RadarDim, value: number) => void;
  /** HR 证据备注 */
  onNote: (turn: number, note: string) => void;
  /** 面试已结束时只读 */
  readOnly?: boolean;
}

/**
 * 本轮「建议优先打分」的通用六维：
 * 题目直接考查的通用维 + craft 维经 CRAFT_LINKS 映射回的通用维。
 * 其余四维折叠，避免每轮都要拖 6 个滑块。
 */
function primaryDimsOf(turn: InterviewTurn): RadarDim[] {
  const set = new Set<RadarDim>();
  for (const dim of turn.targetDims) {
    if ((RADAR_DIMS as string[]).includes(dim)) {
      set.add(dim as RadarDim);
      continue;
    }
    for (const linked of craftLinks(dim)) set.add(linked);
  }
  return RADAR_DIMS.filter((dim) => set.has(dim));
}

/** 毫秒 → 人类可读时长 */
function formatLatency(ms: number | null): string | null {
  if (typeof ms !== 'number' || ms <= 0) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function InterviewBubble({ turn, onRate, onNote, readOnly = false }: InterviewBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const primaryDims = primaryDimsOf(turn);
  const restDims = RADAR_DIMS.filter((dim) => !primaryDims.includes(dim));
  const visibleDims = expanded ? [...primaryDims, ...restDims] : primaryDims;
  const latency = formatLatency(turn.replyLatencyMs);
  const isFollowup = turn.qId.includes(':fu');

  return (
    <article className="space-y-2 rounded-lg border border-border bg-card p-3">
      {/* 轮次头：轮号 / 追问标记 / 考查维度 */}
      <header className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="tabular-nums">
          第 {turn.turn} 轮
        </Badge>
        {isFollowup && (
          <Badge variant="warning" className="gap-1">
            <MessageSquareQuote className="h-3 w-3" />
            追问
          </Badge>
        )}
        {turn.targetDims.map((dim) => (
          <Badge key={dim} variant="secondary" title={dim}>
            {dimLabel(dim)}
          </Badge>
        ))}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          {latency && (
            <span className="inline-flex items-center gap-0.5">
              <Clock className="h-3 w-3" />
              {latency}
            </span>
          )}
          {typeof turn.tokensUsed === 'number' && (
            <span className="inline-flex items-center gap-0.5 tabular-nums">
              <Coins className="h-3 w-3" />
              {turn.tokensUsed}
            </span>
          )}
        </span>
      </header>

      {/* 题干 */}
      <div className="rounded-md bg-muted/60 px-3 py-2">
        <p className="text-xs font-medium text-muted-foreground">面试官</p>
        <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{turn.question}</p>
      </div>

      {/* 回答 */}
      <div className="rounded-md border border-[#FFD233]/40 bg-[#FFD233]/5 px-3 py-2">
        <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <User2 className="h-3 w-3" />
          候选回答
        </p>
        <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {turn.replyText}
        </p>
      </div>

      {/* HR 逐维打分：证据 → 可量化能力 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">HR 本轮评分（0–5）</p>
          {restDims.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {expanded ? (
                <>
                  收起其余维度 <ChevronUp className="h-3 w-3" />
                </>
              ) : (
                <>
                  展开全部六维 <ChevronDown className="h-3 w-3" />
                </>
              )}
            </button>
          )}
        </div>

        {visibleDims.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">本题不直接映射通用六维，可展开手动补分。</p>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {visibleDims.map((dim) => {
              const value = turn.hrRatings[dim];
              const rated = typeof value === 'number';
              return (
                <label key={dim} className="flex items-center gap-2 text-xs">
                  <span className="w-12 shrink-0 text-muted-foreground">{RADAR_DIM_LABELS[dim]}</span>
                  <input
                    type="range"
                    min={0}
                    max={5}
                    step={0.5}
                    disabled={readOnly}
                    value={rated ? value : 0}
                    onChange={(e) => onRate(turn.turn, dim, Number(e.target.value))}
                    className="h-1 flex-1 cursor-pointer accent-[#FFD233] disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <span
                    className={`w-7 shrink-0 text-right tabular-nums ${
                      rated ? 'font-semibold text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {rated ? value.toFixed(1) : '—'}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* 证据备注：写进 InterviewReport.dimEvidence，供绩效侧复盘 */}
      <textarea
        rows={2}
        readOnly={readOnly}
        value={turn.evidenceNote ?? ''}
        onChange={(e) => onNote(turn.turn, e.target.value)}
        placeholder="证据备注（可选）：这一轮暴露了什么？"
        className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring read-only:opacity-70"
      />
    </article>
  );
}
