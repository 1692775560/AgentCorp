/**
 * src/components/marketplace/BossFavoriteLeaderboard.tsx
 * 市场页「最受 boss 青睐」工种赛道榜。
 *
 * 按工种赛道（code/text/image）展示 Top3：实体墨色榜首 + --neu-ink-soft 计数。
 * 数据来自 reactionStore.getFavorites（本地聚合），无数据时展示空态。
 */
import { useEffect, useState } from 'react';
import { Crown, Medal, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getFavorites } from '@/services/reactionStore';
import type { JobType } from '@/types/evaluation';
import type { FavoriteRanking } from '@/types/reactions';

const JOB_TRACKS: { jobType: JobType; label: string }[] = [
  { jobType: 'code', label: '代码' },
  { jobType: 'text', label: '文案' },
  { jobType: 'image', label: '图像' },
];

const RANK_ICONS = [Crown, Medal, Medal];

function TrackPanel({ jobType, label }: { jobType: JobType; label: string }) {
  const [ranking, setRanking] = useState<FavoriteRanking | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getFavorites(jobType)
      .then((r) => {
        if (active) setRanking(r);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : '加载失败');
      });
    return () => {
      active = false;
    };
  }, [jobType]);

  const top3 = ranking?.ranking.slice(0, 3) ?? [];

  return (
    <div className="glass-sm rounded-2xl p-4">
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-[var(--neu-ink)]" />
        <h3 className="text-sm font-bold text-[var(--neu-ink)]">{label}赛道</h3>
        <span className="ml-auto text-[10px] font-semibold text-[var(--neu-ink-soft)]">
          最受 boss 青睐
        </span>
      </div>
      <div className="mt-3 space-y-2">
        {top3.length === 0 && (
          <p className="rounded-xl border border-dashed border-[var(--neu-ink-soft)]/30 px-3 py-4 text-center text-[11px] text-[var(--neu-ink-soft)]">
            {error ? '加载失败' : '暂无青睐投票'}
          </p>
        )}
        {top3.map((entry, idx) => {
          const Icon = RANK_ICONS[idx] ?? Medal;
          const isTop1 = idx === 0;
          return (
            <div
              key={entry.agentId}
              className={cn(
                'flex items-center gap-2.5 rounded-xl px-3 py-2',
                isTop1
                  ? 'bg-[var(--neu-ink)] text-[var(--neu-surface)]'
                  : 'neu-inset text-[var(--neu-ink)]',
              )}
            >
              <Icon
                size={14}
                className={isTop1 ? 'text-[var(--neu-surface)]' : 'text-[var(--neu-ink-soft)]'}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold">{entry.agentName || entry.agentId}</p>
                <p className="truncate text-[10px] opacity-70">{entry.agentId}</p>
              </div>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums',
                  isTop1
                    ? 'bg-[var(--neu-surface)] text-[var(--neu-ink)]'
                    : 'bg-[var(--neu-ink)] text-[var(--neu-surface)]',
                )}
              >
                {entry.count} 票
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BossFavoriteLeaderboard() {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Crown size={16} className="text-[var(--neu-ink)]" />
        <h2 className="text-base font-bold text-[var(--neu-ink)]">最受 boss 青睐</h2>
        <span className="text-xs text-[var(--neu-ink-soft)]">
          测评后深度认可投票（一次测评一票）
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {JOB_TRACKS.map((track) => (
          <TrackPanel key={track.jobType} jobType={track.jobType} label={track.label} />
        ))}
      </div>
    </section>
  );
}

export default BossFavoriteLeaderboard;
