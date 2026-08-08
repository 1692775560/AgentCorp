/**
 * src/components/arena/ArenaSetupPanel.tsx
 * Arena 需求输入区：需求文本 + 工种选择 + 候选选择（text 通道：agentId/名称/答案）。
 *
 * 新拟物约定：底色 --neu-surface、文字 --neu-ink/--neu-ink-soft；
 * 输入/激活态用 .neu-inset（内阴影），可交互按钮用 .neu-btn。
 */
import { useState } from 'react';
import { Plus, Trash2, Swords } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useArenaStore } from '@/stores/arenaStore';
import type { JobType } from '@/types/evaluation';

const JOB_OPTIONS: { value: JobType; label: string }[] = [
  { value: 'code', label: '代码' },
  { value: 'text', label: '文案' },
  { value: 'image', label: '图像' },
];

export function ArenaSetupPanel() {
  const requirementText = useArenaStore((s) => s.requirementText);
  const jobType = useArenaStore((s) => s.jobType);
  const candidates = useArenaStore((s) => s.candidates);
  const status = useArenaStore((s) => s.status);
  const setRequirementText = useArenaStore((s) => s.setRequirementText);
  const setJobType = useArenaStore((s) => s.setJobType);
  const addCandidate = useArenaStore((s) => s.addCandidate);
  const removeCandidate = useArenaStore((s) => s.removeCandidate);
  const clearCandidates = useArenaStore((s) => s.clearCandidates);
  const compare = useArenaStore((s) => s.compare);

  const [agentId, setAgentId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [answer, setAnswer] = useState('');

  const comparing = status === 'comparing';

  const addCandidateRef = () => {
    const id = agentId.trim();
    if (!id) return;
    addCandidate({
      agentId: id,
      agentName: agentName.trim() || id,
      channel: 'text',
      answer: answer.trim() || '（候选未提供答案）',
    });
    setAgentId('');
    setAgentName('');
    setAnswer('');
  };

  return (
    <section className="glass space-y-5 p-6">
      <div className="flex items-center gap-2">
        <Swords size={18} className="text-[var(--neu-ink)]" />
        <h2 className="text-base font-bold text-[var(--neu-ink)]">Arena 个性化对决</h2>
      </div>

      {/* 需求文本 */}
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-[var(--neu-ink-soft)]">
          你的需求（原话即题面，候选将直接面对它作答）
        </label>
        <textarea
          value={requirementText}
          onChange={(e) => setRequirementText(e.target.value)}
          placeholder="例如：要一个稳定又便宜的后端 agent，能快速迭代 API 并自写测试"
          rows={3}
          className="neu-inset w-full resize-none rounded-2xl p-3.5 text-sm text-[var(--neu-ink)] placeholder:text-[var(--neu-ink-soft)]/60 focus:outline-none"
        />
      </div>

      {/* 工种选择 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-[var(--neu-ink-soft)]">工种</span>
        {JOB_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setJobType(opt.value)}
            className={cn(
              'rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors',
              jobType === opt.value
                ? 'bg-[var(--neu-ink)] text-[var(--neu-surface)] shadow-sm'
                : 'bg-[var(--neu-surface)] text-[var(--neu-ink-soft)] shadow-[3px_3px_6px_var(--neu-shadow-d),-3px_-3px_6px_var(--neu-shadow-l)] hover:text-[var(--neu-ink)]',
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* 候选列表 */}
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-[var(--neu-ink-soft)]">
          候选（同工种 2..N 个，text 通道直接贴答案）
        </label>
        <div className="space-y-2">
          {candidates.length === 0 && (
            <p className="rounded-2xl border border-dashed border-[var(--neu-ink-soft)]/30 px-3 py-4 text-center text-xs text-[var(--neu-ink-soft)]">
              尚未选择候选。可在下方添加两个以上候选后发起对决。
            </p>
          )}
          {candidates.map((c) => (
            <div
              key={c.agentId}
              className="neu-inset flex items-center justify-between gap-3 rounded-xl px-3.5 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[var(--neu-ink)]">
                  {c.agentName || c.agentId}
                </p>
                <p className="truncate text-xs text-[var(--neu-ink-soft)]">{c.agentId}</p>
              </div>
              <button
                type="button"
                onClick={() => removeCandidate(c.agentId)}
                className="rounded-full p-1.5 text-[var(--neu-ink-soft)] transition-colors hover:text-[var(--neu-ink)]"
                aria-label={`移除 ${c.agentName || c.agentId}`}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 添加候选 */}
      <div className="space-y-2 rounded-2xl bg-[var(--neu-surface)] p-3.5 shadow-[inset_3px_3px_6px_var(--neu-shadow-d),inset_-3px_-3px_6px_var(--neu-shadow-l)]">
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
          placeholder="候选答案（text 通道：直接贴该 agent 的作答）"
          rows={2}
          className="neu-inset w-full resize-none rounded-xl px-3 py-2 text-xs text-[var(--neu-ink)] placeholder:text-[var(--neu-ink-soft)]/60 focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={addCandidateRef} disabled={!agentId.trim()}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            添加候选
          </Button>
          {candidates.length > 0 && (
            <Button size="sm" variant="ghost" onClick={clearCandidates}>
              清空
            </Button>
          )}
        </div>
      </div>

      {/* 发起对决 */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => void compare()}
          disabled={comparing || candidates.length < 2 || !requirementText.trim()}
          className="flex-1 bg-[var(--neu-ink)] text-[var(--neu-surface)] hover:opacity-90"
        >
          {comparing ? '候选作答中…' : '发起对决'}
        </Button>
        <span className="text-[11px] text-[var(--neu-ink-soft)]">
          {candidates.length < 2 ? '需至少 2 个候选' : `${candidates.length} 个候选就绪`}
        </span>
      </div>
    </section>
  );
}

export default ArenaSetupPanel;
