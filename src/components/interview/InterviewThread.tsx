/**
 * src/components/interview/InterviewThread.tsx
 * 面试对话主轴（模块 B · 设计 §4.2）—— 「对话式收敛」的舞台。
 *
 * 自上而下：
 *   题序进度（P1 理解 → P2 手艺 → P3 压力，阶段不可颠倒）
 *   → 历史轮次气泡（含 HR 逐维打分）
 *   → 当前题卡（可一键真实调度候选作答，失败降级手动粘贴）
 *   → 追问建议芯片（把下一轮打在证据缺口上）
 *   → 输入区（复用 Chat 页 ChatInput，支持粘贴/附件）
 *
 * 状态全部来自 useInterviewStore，本组件只做编排与呈现。
 */
import { AlertTriangle, Loader2, PlayCircle, SkipForward, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChatInput } from '@/pages/Chat/ChatInput';
import { InterviewBubble } from '@/components/interview/InterviewBubble';
import { FollowupSuggestChips } from '@/components/interview/FollowupSuggestChips';
import { PHASE_HINTS, PHASE_LABELS, PHASE_ORDER } from '@/engine/interview/questionBank';
import { dimLabel } from '@/engine/interview/dimTracker';
import { useInterviewStore } from '@/stores/interview';
import type { InterviewPhase } from '@/types/interview';

/** 阶段徽章配色（越往后压力越大） */
const PHASE_TONE: Record<InterviewPhase, string> = {
  P1_understanding: 'bg-sky-500/15 text-sky-600 dark:text-sky-300 border-sky-500/40',
  P2_craft_probe: 'bg-[#FFD233]/20 text-amber-700 dark:text-[#FFD233] border-[#FFD233]/50',
  P3_pressure: 'bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/40',
};

export function InterviewThread() {
  const status = useInterviewStore((s) => s.status);
  const plan = useInterviewStore((s) => s.plan);
  const turns = useInterviewStore((s) => s.turns);
  const askedQIds = useInterviewStore((s) => s.askedQIds);
  const currentQuestion = useInterviewStore((s) => s.currentQuestion);
  const suggestions = useInterviewStore((s) => s.suggestions);
  const dispatching = useInterviewStore((s) => s.dispatching);
  const lastMode = useInterviewStore((s) => s.lastMode);
  const sessionKey = useInterviewStore((s) => s.sessionKey);
  const error = useInterviewStore((s) => s.error);

  const askAgent = useInterviewStore((s) => s.askAgent);
  const submitReply = useInterviewStore((s) => s.submitReply);
  const rateTurn = useInterviewStore((s) => s.rateTurn);
  const noteTurn = useInterviewStore((s) => s.noteTurn);
  const applyFollowup = useInterviewStore((s) => s.applyFollowup);
  const skipQuestion = useInterviewStore((s) => s.skipQuestion);
  const clearError = useInterviewStore((s) => s.clearError);

  const running = status === 'running';
  const finished = status === 'finished';
  const idle = status === 'idle';

  /** 各阶段已问 / 总题（题序进度条） */
  const phaseStats = PHASE_ORDER.map((phase) => {
    const total = plan.filter((q) => q.phase === phase).length;
    const done = plan.filter((q) => q.phase === phase && askedQIds.includes(q.qId)).length;
    return { phase, total, done };
  });

  return (
    <div className="flex h-full flex-col">
      {/* 题序进度：三阶段递进一眼可见 */}
      <div className="shrink-0 border-b border-white/60 bg-white/45 px-4 py-2.5 backdrop-blur-md dark:bg-white/5">
        <div className="flex flex-wrap items-center gap-2">
          {phaseStats.map(({ phase, total, done }) => {
            const active = currentQuestion?.phase === phase;
            return (
              <div
                key={phase}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-opacity ${
                  PHASE_TONE[phase]
                } ${active ? 'opacity-100 ring-1 ring-current' : 'opacity-60'}`}
                title={PHASE_HINTS[phase]}
              >
                <span className="font-medium">{PHASE_LABELS[phase]}</span>
                <span className="tabular-nums">
                  {done}/{total}
                </span>
              </div>
            );
          })}
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            已完成 {turns.length} 轮
          </span>
        </div>
      </div>

      {/* 轮次流 */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {idle && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium text-foreground">尚未开始面试</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              左侧选择候选后点击「开始面试」。题序会依据人才市场的任务画像自动生成，
              让考查维度对准真实需求。
            </p>
          </div>
        )}

        {turns.map((turn) => (
          <InterviewBubble
            key={`${turn.turn}-${turn.qId}`}
            turn={turn}
            onRate={rateTurn}
            onNote={noteTurn}
            readOnly={finished}
          />
        ))}

        {/* 当前题卡 */}
        {running && currentQuestion && (
          <section className="neu-inset space-y-2 rounded-2xl border-0 bg-[#FFD233]/10 p-3.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={PHASE_TONE[currentQuestion.phase]}>
                {PHASE_LABELS[currentQuestion.phase]}
              </Badge>
              {currentQuestion.targetDims.map((dim) => (
                <Badge key={dim} variant="secondary" title={dim}>
                  {dimLabel(dim)}
                </Badge>
              ))}
              <span className="ml-auto text-[11px] text-muted-foreground">当前待问</span>
            </div>

            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {currentQuestion.prompt}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => void askAgent()}
                disabled={dispatching || sessionKey.length === 0}
                title={sessionKey.length === 0 ? '该候选无可用会话键，请在下方手动粘贴回答' : '真实调度候选作答'}
              >
                {dispatching ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    等待候选作答…
                  </>
                ) : (
                  <>
                    <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
                    让候选作答
                  </>
                )}
              </Button>
              <Button size="sm" variant="ghost" onClick={skipQuestion} disabled={dispatching}>
                <SkipForward className="mr-1.5 h-3.5 w-3.5" />
                跳过本题
              </Button>
              {lastMode === 'manual' && (
                <span className="text-[11px] text-muted-foreground">
                  已降级为手动模式：把候选回答粘贴到下方输入框即可。
                </span>
              )}
            </div>
          </section>
        )}

        {running && !currentQuestion && (
          <div className="rounded-2xl border border-dashed border-white/50 bg-white/40 px-3 py-4 text-center text-xs text-muted-foreground backdrop-blur dark:bg-white/5">
            题序已问完。可采纳下方追问建议补齐证据缺口，或在左栏结束面试生成 S2 评分卡。
          </div>
        )}

        {finished && (
          <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-3 text-center text-xs text-emerald-700 backdrop-blur dark:text-emerald-300">
            面试已结束，报告已落库并回写绩效基线。右栏可查看最终六维与收敛轨迹。
          </div>
        )}
      </div>

      {/* 错误条 */}
      {error && (
        <div className="mx-4 mb-2 flex items-start gap-2 rounded-2xl border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-xs text-orange-700 backdrop-blur dark:text-orange-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={clearError} className="shrink-0 opacity-70 hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 追问建议 + 输入区 */}
      <div className="shrink-0 space-y-2 border-t border-border px-4 py-3">
        <FollowupSuggestChips
          suggestions={suggestions}
          onApply={applyFollowup}
          disabled={!running}
        />
        <ChatInput
          onSend={(text) => submitReply(text)}
          disabled={!running || !currentQuestion || dispatching}
          sending={dispatching}
        />
      </div>
    </div>
  );
}
