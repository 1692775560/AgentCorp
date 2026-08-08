/**
 * src/components/arena/ArenaPickBar.tsx
 * 用户主观裁决条：winner / draw / none 三选一 → userPick 回传 → Elo 展示。
 *
 * 新拟物约定：实体墨色按钮 + --neu-surface 反色文字；
 * Elo 快照用 --neu-ink-soft 展示（禁止低对比灰色小字）。
 */
import { Check, Minus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useArenaStore } from '@/stores/arenaStore';
import type { ArenaMatch, EloSnapshot } from '@/types/arena';

function eloDeltaText(delta: number): string {
  if (delta === 0) return '±0';
  return delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
}

export function ArenaPickBar({
  match,
  eloSnapshot,
}: {
  match: ArenaMatch;
  eloSnapshot: EloSnapshot;
}) {
  const pick = useArenaStore((s) => s.pick);
  const status = useArenaStore((s) => s.status);
  const picked = status === 'picked' || match.status !== 'pending';

  if (picked) {
    return (
      <section className="glass space-y-3 p-6">
        <h2 className="text-base font-bold text-[var(--neu-ink)]">你的裁决已生效</h2>
        <p className="text-sm text-[var(--neu-ink-soft)]">
          {match.userPick === 'none'
            ? '你选择了「都不满意」，该局不计 Elo。'
            : match.userPick === 'draw'
              ? '你选择了「平局」，双方各 +0.5。'
              : `你选择了 ${match.candidates.find((c) => c.agentId === match.userPick)?.agentName ?? match.userPick} 胜出。`}
        </p>

        {/* Elo 变化 */}
        {Object.keys(match.eloDelta).length > 0 && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {match.candidates.map((c) => {
              const delta = match.eloDelta[c.agentId] ?? 0;
              return (
                <div key={c.agentId} className="neu-inset flex items-center justify-between rounded-xl px-3.5 py-2.5">
                  <span className="truncate text-sm font-semibold text-[var(--neu-ink)]">
                    {c.agentName || c.agentId}
                  </span>
                  <span
                    className={cn(
                      'text-sm font-bold tabular-nums',
                      delta > 0 ? 'text-[var(--neu-ink)]' : 'text-[var(--neu-ink-soft)]',
                    )}
                  >
                    {eloDeltaText(delta)}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Elo 快照（主观主榜 + 客观辅榜） */}
        <EloSnapshotView match={match} eloSnapshot={eloSnapshot} />
      </section>
    );
  }

  return (
    <section className="glass space-y-4 p-6">
      <div>
        <h2 className="text-base font-bold text-[var(--neu-ink)]">你的裁决</h2>
        <p className="mt-0.5 text-xs text-[var(--neu-ink-soft)]">
          主观选择是最终胜负依据（主观 Elo 主榜）；LLM 客观分仅供参考（客观 Elo 辅榜）。
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {match.candidates.map((c) => (
          <Button
            key={c.agentId}
            variant="outline"
            onClick={() => void pick(c.agentId)}
            className="h-auto flex-col gap-1 py-3"
          >
            <span className="text-sm font-bold">{c.agentName || c.agentId}</span>
            <span className="text-[10px] text-[var(--neu-ink-soft)]">
              客观分 {c.objectiveTotal.toFixed(1)}
            </span>
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void pick('draw')} className="flex-1">
          <Minus className="mr-1.5 h-3.5 w-3.5" />
          平局（双方 +0.5）
        </Button>
        <Button variant="ghost" onClick={() => void pick('none')} className="flex-1">
          <X className="mr-1.5 h-3.5 w-3.5" />
          都不满意（不计 Elo）
        </Button>
      </div>
    </section>
  );
}

function EloSnapshotView({
  match,
  eloSnapshot,
}: {
  match: ArenaMatch;
  eloSnapshot: EloSnapshot;
}) {
  const ids = match.candidates.map((c) => c.agentId);
  const hasAny = ids.some(
    (id) => eloSnapshot.subjectiveRatings[id] != null || eloSnapshot.objectiveRatings[id] != null,
  );
  if (!hasAny) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--neu-ink-soft)]/30 px-3 py-3 text-center text-xs text-[var(--neu-ink-soft)]">
        暂无 Elo 数据：完成一场有效对决后，主观/客观双榜将在此展示。
      </p>
    );
  }
  return (
    <div className="neu-inset rounded-2xl p-3.5">
      <p className="text-xs font-semibold text-[var(--neu-ink-soft)]">Elo 双榜快照</p>
      <div className="mt-2 space-y-1.5">
        {match.candidates.map((c) => {
          const sub = eloSnapshot.subjectiveRatings[c.agentId];
          const obj = eloSnapshot.objectiveRatings[c.agentId];
          if (sub == null && obj == null) return null;
          return (
            <div key={c.agentId} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate text-[var(--neu-ink)]">{c.agentName || c.agentId}</span>
              <span className="flex items-center gap-3 tabular-nums text-xs">
                <span className="text-[var(--neu-ink)]">主观 {Math.round(sub ?? 1000)}</span>
                <span className="text-[var(--neu-ink-soft)]">客观 {Math.round(obj ?? 1000)}</span>
                {match.userPick === c.agentId && (
                  <Check size={13} className="text-[var(--neu-ink)]" />
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ArenaPickBar;
