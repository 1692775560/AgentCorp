/**
 * src/components/arena/ArenaCompareView.tsx
 * 对决结果对比卡：展示每个候选的作答 + LLM 客观分（dims 均值 + fit）。
 *
 * 新拟物约定：底色 --neu-surface、文字 --neu-ink/--neu-ink-soft；
 * 高亮 leader 用实体墨色/实体色块（禁止半透明彩底+彩字组合）。
 */
import { Award, Clock, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ArenaMatch } from '@/types/arena';

function formatLatency(ms: number): string {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function dimLabel(dim: string): string {
  const map: Record<string, string> = {
    code_runnability: '可运行',
    code_efficiency: '效率',
    code_test_coverage: '测试覆盖',
    code_maintainability: '可维护',
    code_security: '安全',
    txt_factuality: '事实性',
    txt_coherence: '连贯',
    txt_tone_fit: '语气贴合',
    txt_info_density: '信息密度',
    txt_instruction_follow: '指令遵循',
    img_composition: '构图',
    img_style_fit: '风格贴合',
    img_fidelity: '保真',
    img_aesthetic_consistency: '审美一致',
    img_multimodal_follow: '多模态遵循',
    fit: '需求贴合',
  };
  return map[dim] ?? dim;
}

export function ArenaCompareView({ match }: { match: ArenaMatch }) {
  const leaderId = match.objectiveLeader;
  return (
    <section className="glass space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-[var(--neu-ink)]">对决结果</h2>
        <span className="rounded-full bg-[var(--neu-ink)] px-3 py-1 text-[11px] font-bold text-[var(--neu-surface)]">
          {match.status === 'pending' ? '待你裁决' : match.status === 'picked' ? '已裁决' : '已放弃'}
        </span>
      </div>

      {/* 需求原文 + 题面 */}
      <div className="neu-inset rounded-2xl p-3.5">
        <p className="text-xs font-semibold text-[var(--neu-ink-soft)]">需求</p>
        <p className="mt-0.5 whitespace-pre-wrap text-sm text-[var(--neu-ink)]">
          {match.requirementText}
        </p>
        <p className="mt-2 text-xs font-semibold text-[var(--neu-ink-soft)]">题面</p>
        <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-[var(--neu-ink)]/80">
          {match.taskPrompt}
        </p>
      </div>

      {/* 候选对比卡 */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {match.candidates.map((c) => {
          const isLeader = c.agentId === leaderId;
          const judgement = c.judgement;
          const dims = judgement?.dims ?? {};
          const fit = judgement?.fit ?? 0;
          return (
            <div
              key={c.agentId}
              className={cn(
                'rounded-2xl p-4 transition-shadow',
                isLeader
                  ? 'bg-[var(--neu-ink)] text-[var(--neu-surface)]'
                  : 'neu-inset text-[var(--neu-ink)]',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className={cn('truncate text-sm font-bold', isLeader ? '' : 'text-[var(--neu-ink)]')}>
                    {c.agentName || c.agentId}
                  </p>
                  <p className={cn('truncate text-xs', isLeader ? 'text-[var(--neu-surface)]/70' : 'text-[var(--neu-ink-soft)]')}>
                    {c.agentId}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {isLeader && (
                    <span
                      className={cn(
                        'flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold',
                        isLeader ? 'bg-[var(--neu-surface)] text-[var(--neu-ink)]' : 'bg-[var(--neu-ink)] text-[var(--neu-surface)]',
                      )}
                    >
                      <Award size={10} />
                      LLM 榜首
                    </span>
                  )}
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums',
                      isLeader ? 'bg-[var(--neu-surface)] text-[var(--neu-ink)]' : 'bg-[var(--neu-ink)] text-[var(--neu-surface)]',
                    )}
                  >
                    {c.objectiveTotal.toFixed(1)}
                  </span>
                </div>
              </div>

              {/* 作答 */}
              <div className={cn('mt-3 flex items-start gap-1.5', isLeader ? 'text-[var(--neu-surface)]/90' : 'text-[var(--neu-ink)]/85')}>
                <FileText size={13} className="mt-0.5 shrink-0" />
                <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed">
                  {c.answerText}
                </p>
              </div>

              {/* 客观分维度 */}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {Object.entries(dims).map(([dim, score]) => (
                  <span
                    key={dim}
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums',
                      isLeader
                        ? 'bg-[var(--neu-surface)]/15 text-[var(--neu-surface)]'
                        : 'bg-[var(--neu-ink)]/10 text-[var(--neu-ink)]',
                    )}
                  >
                    {dimLabel(dim)} {Number(score).toFixed(1)}
                  </span>
                ))}
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums',
                    isLeader
                      ? 'bg-[var(--neu-surface)]/15 text-[var(--neu-surface)]'
                      : 'bg-[var(--neu-ink)]/10 text-[var(--neu-ink)]',
                  )}
                >
                  贴合 {fit.toFixed(1)}
                </span>
              </div>

              <div className={cn('mt-2.5 flex items-center gap-1.5 text-[11px]', isLeader ? 'text-[var(--neu-surface)]/70' : 'text-[var(--neu-ink-soft)]')}>
                <Clock size={11} />
                {formatLatency(c.latencyMs)} · {c.channel}
                {judgement?.paddingDetected ? ' · 疑似注水' : ''}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default ArenaCompareView;
