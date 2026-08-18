/**
 * src/components/interview/UserQuestionPanel.tsx
 * 面试用户自定义题。
 *
 * P3 完成后由 HR 主动发起的可选环节：
 *   用户按实际情况出题（无参考答案）→ 同工种候选作答（复用 Arena compare）
 *   → 用户主观选择（复用 Arena user-pick）→ 落为 InterviewReport.userQuestionRound。
 *
 * 关键边界：**不进 turns[]、不进 dimTracker 证据、不进模型分**；
 * 用户主观判断是唯一标准，arena_judge 客观分仅作参考展示。
 */
import { useState } from 'react';
import { HelpCircle, Plus, Trash2, Check, Minus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useInterviewStore } from '@/stores/interview';
import { useArenaStore } from '@/stores/arenaStore';
import type { CandidateRef } from '@/types/arena';

export function UserQuestionPanel() {
  const userQuestionStatus = useInterviewStore((s) => s.userQuestionStatus);
  const userQuestionError = useInterviewStore((s) => s.userQuestionError);
  const userQuestionRound = useInterviewStore((s) => s.userQuestionRound);
  const startUserQuestion = useInterviewStore((s) => s.startUserQuestion);
  const pickUserQuestion = useInterviewStore((s) => s.pickUserQuestion);
  const resetUserQuestion = useInterviewStore((s) => s.resetUserQuestion);

  const match = useArenaStore((s) => s.match);

  const [question, setQuestion] = useState('');
  const [candidates, setCandidates] = useState<CandidateRef[]>([]);
  const [agentId, setAgentId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [answer, setAnswer] = useState('');

  const comparing = userQuestionStatus === 'comparing';

  const addCandidate = () => {
    const id = agentId.trim();
    if (!id) return;
    if (candidates.some((c) => c.agentId === id)) return;
    setCandidates([
      ...candidates,
      {
        agentId: id,
        agentName: agentName.trim() || id,
        channel: 'text',
        answer: answer.trim() || '（候选未提供答案）',
      },
    ]);
    setAgentId('');
    setAgentName('');
    setAnswer('');
  };

  const removeCandidate = (id: string) =>
    setCandidates(candidates.filter((c) => c.agentId !== id));

  const handleStart = async () => {
    const ok = await startUserQuestion(question, candidates);
    if (ok) {
      // 保留候选快照（报告展示用），但清空输入
      setQuestion('');
      setCandidates([]);
    }
  };

  const showCompare =
    userQuestionStatus === 'ready' || userQuestionStatus === 'picked';
  const showMatch = showCompare && match && userQuestionRound?.matchId === match.matchId;

  return (
    <section className="neu-inset space-y-4 rounded-2xl p-4">
      <div className="flex items-center gap-2">
        <HelpCircle size={16} className="text-[var(--neu-ink)]" />
        <h3 className="text-sm font-bold text-[var(--neu-ink)]">用户自定义题（无参考答案）</h3>
        <span className="ml-auto rounded-full bg-[var(--neu-ink)] px-2.5 py-0.5 text-[10px] font-bold text-[var(--neu-surface)]">
          {userQuestionStatus === 'ready' && '待你裁决'}
          {userQuestionStatus === 'picked' && '已裁决'}
          {userQuestionStatus === 'comparing' && '候选中'}
          {userQuestionStatus === 'error' && '出错'}
          {userQuestionStatus === 'idle' && '可选'}
        </span>
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--neu-ink-soft)]">
        按你的实际情况出题（无标准答案），让同工种候选作答后由你主观判断。
        该环节**不进面试评分维度、不进模型分**，仅记录你的偏好。
      </p>

      {userQuestionError && (
        <div className="rounded-xl border border-[var(--neu-ink)]/20 bg-[var(--neu-surface)] px-3 py-2 text-xs text-[var(--neu-ink)]">
          {userQuestionError}
        </div>
      )}

      {!showCompare && (
        <div className="space-y-3">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="例如：如果预算砍半、工期不变，你会怎么调整方案？"
            rows={2}
            className="neu-inset w-full resize-none rounded-xl px-3 py-2 text-sm text-[var(--neu-ink)] placeholder:text-[var(--neu-ink-soft)]/60 focus:outline-none"
          />

          <div className="space-y-2">
            {candidates.length === 0 && (
              <p className="rounded-xl border border-dashed border-[var(--neu-ink-soft)]/30 px-3 py-3 text-center text-[11px] text-[var(--neu-ink-soft)]">
                尚未选择候选。添加至少两个候选后发起用户题。
              </p>
            )}
            {candidates.map((c) => (
              <div
                key={c.agentId}
                className="flex items-center justify-between gap-2 rounded-xl bg-[var(--neu-surface)] px-3 py-2 shadow-[inset_3px_3px_6px_var(--neu-shadow-d),inset_-3px_-3px_6px_var(--neu-shadow-l)]"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-[var(--neu-ink)]">
                    {c.agentName || c.agentId}
                  </p>
                  <p className="truncate text-[10px] text-[var(--neu-ink-soft)]">{c.agentId}</p>
                </div>
                <button
                  type="button"
                  onClick={() => removeCandidate(c.agentId)}
                  className="rounded-full p-1 text-[var(--neu-ink-soft)] hover:text-[var(--neu-ink)]"
                  aria-label="移除候选"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <input
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="agentId（必填）"
              className="neu-inset rounded-xl px-3 py-2 text-xs text-[var(--neu-ink)] placeholder:text-[var(--neu-ink-soft)]/60 focus:outline-none"
            />
            <input
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="名称（可选）"
              className="neu-inset rounded-xl px-3 py-2 text-xs text-[var(--neu-ink)] placeholder:text-[var(--neu-ink-soft)]/60 focus:outline-none"
            />
          </div>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="候选答案（text 通道）"
            rows={2}
            className="neu-inset w-full resize-none rounded-xl px-3 py-2 text-xs text-[var(--neu-ink)] placeholder:text-[var(--neu-ink-soft)]/60 focus:outline-none"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={addCandidate} disabled={!agentId.trim()}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              添加候选
            </Button>
            <Button
              size="sm"
              onClick={() => void handleStart()}
              disabled={comparing || !question.trim() || candidates.length < 2}
              className="bg-[var(--neu-ink)] text-[var(--neu-surface)] hover:opacity-90"
            >
              {comparing ? '候选中…' : '发起用户题'}
            </Button>
          </div>
        </div>
      )}

      {showMatch && match && (
        <div className="space-y-3">
          {/* 候选对比（客观分仅供参考） */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {match.candidates.map((c) => {
              const isPicked = userQuestionRound?.pick === c.agentId;
              return (
                <div
                  key={c.agentId}
                  className={cn(
                    'rounded-xl p-3',
                    isPicked
                      ? 'bg-[var(--neu-ink)] text-[var(--neu-surface)]'
                      : 'neu-inset text-[var(--neu-ink)]',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-bold">{c.agentName || c.agentId}</p>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums',
                        isPicked
                          ? 'bg-[var(--neu-surface)] text-[var(--neu-ink)]'
                          : 'bg-[var(--neu-ink)] text-[var(--neu-surface)]',
                      )}
                    >
                      {c.objectiveTotal.toFixed(1)}
                    </span>
                  </div>
                  <p className="mt-1.5 max-h-20 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed opacity-90">
                    {c.answerText}
                  </p>
                </div>
              );
            })}
          </div>

          {/* 裁决区 */}
          {userQuestionStatus === 'ready' ? (
            <div className="flex flex-wrap gap-2">
              {match.candidates.map((c) => (
                <Button key={c.agentId} size="sm" variant="outline" onClick={() => void pickUserQuestion(c.agentId)}>
                  <Check className="mr-1 h-3.5 w-3.5" />
                  {c.agentName || c.agentId}
                </Button>
              ))}
              <Button size="sm" variant="outline" onClick={() => void pickUserQuestion('draw')}>
                <Minus className="mr-1 h-3.5 w-3.5" />
                平局
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void pickUserQuestion('none')}>
                <X className="mr-1 h-3.5 w-3.5" />
                都不满意
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--neu-ink-soft)]">
              <span>
                已选择：
                {userQuestionRound?.pick === 'draw'
                  ? '平局'
                  : userQuestionRound?.pick === 'none'
                    ? '都不满意'
                    : (match.candidates.find((c) => c.agentId === userQuestionRound?.pick)
                        ?.agentName ?? userQuestionRound?.pick)}
              </span>
              <Button size="sm" variant="ghost" onClick={resetUserQuestion}>
                重新发起
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default UserQuestionPanel;
