/**
 * src/components/interview/InterviewBubble.tsx
 * 单轮问答气泡（模块 B · 设计 §4.2）。
 *
 * 一轮 = 「题干（考查维度）→ 候选回答 → HR 逐维打分 + 证据备注」。
 * 打分不是走过场：hrRatings 会被 dimTracker.aggregateHrRadar 聚合成 finalRadar，
 * 进而成为 S2 评分卡与绩效基线的输入（★通道②的源头数据）。
 *
 * UI 打磨：苹果极简科技风 —— 磨砂玻璃圆角卡 + 左/右对话气泡（面试官 / 候选）
 * + 精致磨砂滑块（六维打分）。纯受控组件：不持有面试状态，全部通过回调上抛。
 */
import { useState } from 'react';
import { Bot, ChevronDown, ChevronUp, Clock, Coins, MessageSquareQuote, User2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import { RADAR_DIM_LABELS } from '@/engine/marketplace/radarSource';
import { dimLabel } from '@/engine/interview/dimTracker';
import type { InterviewTurn } from '@/types/interview';
import type { RadarDim } from '@/types/evaluation';

interface InterviewBubbleProps {
  turn: InterviewTurn;
  /** HR 逐维打分（0–5，0.5 步进）。dim 可为通用六维或 craft 维（P1#8 起支持 craft 维） */
  onRate: (turn: number, dim: string, value: number) => void;
  /** HR 证据备注 */
  onNote: (turn: number, note: string) => void;
  /** 面试已结束时只读 */
  readOnly?: boolean;
}

/** 维度标签：通用六维用雷达标签，craft 维用 dimLabel 中文（避免硬编码英文 key） */
function labelOf(dim: string): string {
  if ((RADAR_DIMS as string[]).includes(dim)) return RADAR_DIM_LABELS[dim as RadarDim];
  return dimLabel(dim);
}

/** 毫秒 → 人类可读时长 */
function formatLatency(ms: number | null): string | null {
  if (typeof ms !== 'number' || ms <= 0) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function InterviewBubble({ turn, onRate, onNote, readOnly = false }: InterviewBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  // P1#8：本轮可直接打分的维度 = 本题考查的全部维度（通用六维 + craft 维）。
  // 始终展示直接考查的通用六维 + 全部 craft 维；其余未直接考查的通用六维折叠，
  // 展开后补出（避免每轮都堆 6 个滑块，但 craft 维必须始终可见可评）。
  const radarDims = turn.targetDims.filter((d) => (RADAR_DIMS as string[]).includes(d)) as RadarDim[];
  const craftDims = turn.targetDims.filter((d) => !(RADAR_DIMS as string[]).includes(d));
  const restRadarDims = RADAR_DIMS.filter((d) => !radarDims.includes(d));
  const visibleDims = expanded
    ? [...radarDims, ...restRadarDims, ...craftDims]
    : [...radarDims, ...craftDims];
  const hasCollapsed = restRadarDims.length > 0;
  const latency = formatLatency(turn.replyLatencyMs);
  const isFollowup = turn.qId.includes(':fu');

  return (
    <article className="glass-panel space-y-3 p-4">
      {/* 轮次头：轮号 / 追问标记 / 考查维度 */}
      <header className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="rounded-full tabular-nums">
          第 {turn.turn} 轮
        </Badge>
        {isFollowup && (
          <Badge variant="warning" className="gap-1 rounded-full">
            <MessageSquareQuote className="h-3 w-3" />
            追问
          </Badge>
        )}
        {turn.targetDims.map((dim) => (
          <Badge key={dim} variant="secondary" title={dim} className="rounded-full">
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

      {/* 对话气泡：左 = 面试官，右 = 候选（磨砂质感 + 聊天尾角） */}
      <div className="space-y-2.5">
        {/* 面试官 */}
        <div className="flex items-end gap-2">
          <span className="mb-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/70 text-[#1A1C1E] shadow-sm ring-1 ring-black/5 dark:bg-white/10 dark:text-foreground">
            <Bot className="h-4 w-4" />
          </span>
          <div className="max-w-[82%] rounded-2xl rounded-bl-md border border-white/60 bg-white/55 px-3.5 py-2.5 shadow-sm backdrop-blur dark:bg-white/5">
            <p className="mb-0.5 text-[11px] font-medium text-muted-foreground">面试官</p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{turn.question}</p>
          </div>
        </div>

        {/* 候选回答 */}
        <div className="flex items-end justify-end gap-2">
          <div className="max-w-[82%] rounded-2xl rounded-br-md border border-[#FFD233]/60 bg-[#FFF3CD] px-3.5 py-2.5 shadow-sm backdrop-blur">
            <p className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-[var(--neu-ink)]">
              <User2 className="h-3 w-3" />
              候选回答
            </p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{turn.replyText}</p>
          </div>
          <span className="mb-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#FFD233]/40 text-[var(--neu-ink)] shadow-sm ring-1 ring-[#FFD233]/50">
            <User2 className="h-4 w-4" />
          </span>
        </div>
      </div>

      {/* HR 逐维打分：证据 → 可量化能力（磨砂子卡 + 精致滑块） */}
      <div className="glass space-y-2 rounded-2xl p-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">HR 本轮评分（0–5）</p>
          {hasCollapsed && (
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
          <p className="text-[11px] text-muted-foreground">本题不含可打分维度。</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {visibleDims.map((dim) => {
              const value = turn.hrRatings[dim];
              const rated = typeof value === 'number';
              return (
                <label key={dim} className="flex items-center gap-2 text-xs">
                  <span className="w-20 shrink-0 truncate text-muted-foreground" title={dim}>
                    {labelOf(dim)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={5}
                    step={0.5}
                    disabled={readOnly}
                    value={rated ? value : 0}
                    onChange={(e) => onRate(turn.turn, dim, Number(e.target.value))}
                    className="range-glass h-1.5 flex-1 disabled:cursor-not-allowed disabled:opacity-50"
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
        className="w-full resize-y rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-xs text-foreground shadow-sm backdrop-blur placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#FFD233] read-only:opacity-70 dark:bg-white/5"
      />
    </article>
  );
}
