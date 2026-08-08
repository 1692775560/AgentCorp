/**
 * src/pages/Arena/ArenaPage.tsx
 * Arena 个性化对决页（设计 §2 / 独立路由 /arena）。
 *
 * 布局：
 *   需求输入 + 选角（ArenaSetupPanel）
 *   → 对决结果对比卡（ArenaCompareView）
 *   → 用户裁决条 + Elo 双榜（ArenaPickBar）
 *
 * 后端不可用时（status=error）展示降级提示，可重试。
 */
import { AlertTriangle, X } from 'lucide-react';
import { ArenaSetupPanel } from '@/components/arena/ArenaSetupPanel';
import { ArenaCompareView } from '@/components/arena/ArenaCompareView';
import { ArenaPickBar } from '@/components/arena/ArenaPickBar';
import { useArenaStore } from '@/stores/arenaStore';

export function ArenaPage() {
  const match = useArenaStore((s) => s.match);
  const status = useArenaStore((s) => s.status);
  const eloSnapshot = useArenaStore((s) => s.eloSnapshot);
  const error = useArenaStore((s) => s.error);
  const clearError = useArenaStore((s) => s.clearError);

  return (
    <div className="tech-bg h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        {/* 页头 */}
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[var(--neu-ink)]">Arena 对决</h1>
            <p className="mt-1 text-sm text-[var(--neu-ink-soft)]">
              输入你的真实需求 → 同工种候选作答 → LLM 客观分 + 你的主观裁决 → 双轨 Elo 更新
            </p>
          </div>
          <span className="rounded-full bg-[var(--neu-ink)] px-3.5 py-1.5 text-xs font-bold text-[var(--neu-surface)]">
            {status === 'comparing' ? '对决中' : status === 'ready' || status === 'picked' ? '已出结果' : '待开始'}
          </span>
        </header>

        {/* 错误条 */}
        {error && (
          <div className="flex items-start gap-2 rounded-2xl border border-[var(--neu-ink)]/20 bg-[var(--neu-surface)] px-3.5 py-2.5 text-xs text-[var(--neu-ink)] shadow-[inset_3px_3px_6px_var(--neu-shadow-d),inset_-3px_-3px_6px_var(--neu-shadow-l)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={clearError} className="shrink-0 opacity-70 hover:opacity-100">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* 输入区 */}
        <ArenaSetupPanel />

        {/* 结果区 */}
        {match && <ArenaCompareView match={match} />}
        {match && <ArenaPickBar match={match} eloSnapshot={eloSnapshot} />}
      </div>
    </div>
  );
}

export default ArenaPage;
