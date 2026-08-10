/**
 * src/components/interview/CraftTrialPanel.tsx
 * 工种试做题面板（P2 手艺探针的客观分）。
 *
 * 与 DimScoreboard 的分工：看板展示 HR 主观打分的覆盖度，本面板展示
 * LLM-as-judge 的客观判定。两者刻意分开呈现 —— 用户必须能一眼看出
 * 哪些分是模型按固定 rubric 判的、哪些是 HR 自己打的。
 *
 * 展示铁律：judge 不可用时显示「未评测」，绝不显示 0 分；
 * 每个维度分下方可展开逐条 checkpoint 的 hit + 原文引用，
 * 没有引文的判定不作为证据展示。
 */
import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Loader2,
  PlayCircle,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { aggregateCraftDims } from '@/engine/interview/craftAggregate';
import { dimLabel } from '@/engine/interview/dimTracker';
import { useInterviewStore } from '@/stores/interview';
import type { CraftTrialRound } from '@/types/interview';

/** 单题结果卡：分数 + 可展开的 checkpoint 证据 */
function TrialCard({ trial }: { trial: CraftTrialRound }) {
  const [open, setOpen] = useState(false);
  const judgement = trial.judgement;

  return (
    <li className="rounded-lg border border-border bg-background/60 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground" title={trial.title}>
            {trial.title}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {trial.mode === 'agent' ? '候选真实作答' : 'HR 手动录入'}
            {typeof trial.answerLatencyMs === 'number'
              ? ` · ${(trial.answerLatencyMs / 1000).toFixed(1)}s`
              : ''}
            {judgement?.ttft_ms != null ? ` · 首字 ${Math.round(judgement.ttft_ms)}ms` : ''}
          </p>
        </div>
        {judgement === null ? (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            未评测
          </Badge>
        ) : (
          <Badge variant="outline" className="shrink-0 tabular-nums text-[10px]">
            置信 {Math.round(judgement.confidence * 100)}%
          </Badge>
        )}
      </div>

      {judgement === null ? (
        <p className="mt-1.5 text-[11px] text-orange-500">
          {trial.judgeError ?? '评分后端不可用，本题不计分'}
        </p>
      ) : (
        <>
          <ul className="mt-2 space-y-1">
            {Object.entries(judgement.dims).map(([dim, score]) => (
              <li key={dim} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate text-muted-foreground" title={dim}>
                  {dimLabel(dim)}
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-foreground">
                  {score.toFixed(1)} / 5
                </span>
              </li>
            ))}
          </ul>

          {judgement.padding_detected && (
            <p className="mt-1.5 flex items-start gap-1 text-[10px] text-orange-500">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              <span>{judgement.padding_note || '检测到空口承诺，评分已按 rubric 压分'}</span>
            </p>
          )}

          {judgement.unscored_dims.length > 0 && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              本题未覆盖：{judgement.unscored_dims.map(dimLabel).join('、')}
            </p>
          )}

          {judgement.checkpoints.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
              >
                {open ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                评分依据（{judgement.checkpoints.filter((c) => c.hit).length}/
                {judgement.checkpoints.length} 项兑现）
              </button>
              {open && (
                <ul className="mt-1.5 space-y-1.5 border-l-2 border-border pl-2">
                  {judgement.checkpoints.map((cp, i) => (
                    <li key={`${cp.checkpoint}-${i}`} className="text-[10px]">
                      <span className="flex items-start gap-1">
                        {cp.hit ? (
                          <CheckCircle2 className="mt-px h-3 w-3 shrink-0 text-emerald-500" />
                        ) : (
                          <XCircle className="mt-px h-3 w-3 shrink-0 text-muted-foreground" />
                        )}
                        <span className={cp.hit ? 'text-foreground' : 'text-muted-foreground'}>
                          {cp.checkpoint}
                        </span>
                      </span>
                      {cp.hit && cp.quote.trim().length > 0 && (
                        <p className="ml-4 mt-0.5 border-l border-dashed border-border pl-1.5 italic text-muted-foreground">
                          「{cp.quote.trim()}」
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </li>
  );
}

export function CraftTrialPanel() {
  const status = useInterviewStore((s) => s.status);
  const craftTasks = useInterviewStore((s) => s.craftTasks);
  const craftTrials = useInterviewStore((s) => s.craftTrials);
  const craftRunning = useInterviewStore((s) => s.craftRunning);
  const craftActiveTaskId = useInterviewStore((s) => s.craftActiveTaskId);
  const craftError = useInterviewStore((s) => s.craftError);
  const runCraftTask = useInterviewStore((s) => s.runCraftTask);
  const runAllCraftTasks = useInterviewStore((s) => s.runAllCraftTasks);
  const clearCraftError = useInterviewStore((s) => s.clearCraftError);

  const idle = status === 'idle';
  const summary = aggregateCraftDims(craftTrials);
  const pending = craftTasks.filter((t) => !craftTrials.some((r) => r.taskId === t.id));

  return (
    <div className="glass space-y-3 rounded-2xl p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <FlaskConical className="h-4 w-4 text-[#FFD233]" />
          试做题 · 客观分
        </h3>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {summary.judgedCount}/{craftTasks.length} 已评
        </span>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        所有候选做同一道题、走同一套 rubric，分数只取决于答案是否兑现可核验要点，
        与仓库 star 数、雇佣次数无关。
      </p>

      {idle ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          开始面试后，此处按工种加载试做题。
        </p>
      ) : craftTasks.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {craftError ?? '本工种暂无试做题。'}
        </p>
      ) : (
        <>
          {craftError && (
            <div className="flex items-start justify-between gap-2 rounded-md border border-orange-300 bg-orange-50 px-2 py-1.5 text-[11px] text-orange-700 dark:bg-orange-950/30">
              <span className="min-w-0">{craftError}</span>
              <button
                type="button"
                onClick={clearCraftError}
                className="shrink-0 underline"
              >
                知道了
              </button>
            </div>
          )}

          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 flex-1 text-xs"
              disabled={craftRunning || pending.length === 0}
              onClick={() => void runAllCraftTasks()}
            >
              {craftRunning ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <PlayCircle className="mr-1 h-3 w-3" />
              )}
              {craftRunning ? '评测中…' : `跑完剩余 ${pending.length} 题`}
            </Button>
          </div>

          {craftTrials.length > 0 && (
            <ul className="space-y-2">
              {craftTrials.map((trial) => (
                <TrialCard key={trial.taskId} trial={trial} />
              ))}
            </ul>
          )}

          {pending.length > 0 && (
            <ul className="space-y-1">
              {pending.map((task) => (
                <li
                  key={task.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-dashed border-border px-2 py-1.5"
                >
                  <span className="truncate text-[11px] text-muted-foreground" title={task.title}>
                    {task.title}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-2 text-[10px]"
                    disabled={craftRunning}
                    onClick={() => void runCraftTask(task.id)}
                  >
                    {craftRunning && craftActiveTaskId === task.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      '开跑'
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {summary.unscored.length > 0 && (
            <p className="text-[10px] text-muted-foreground">
              尚未评上分的维度：{summary.unscored.map(dimLabel).join('、')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
