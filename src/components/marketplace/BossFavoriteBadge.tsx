/**
 * src/components/marketplace/BossFavoriteBadge.tsx
 * 「最受 boss 青睐」徽章 + 投票入口（T05 / 设计 §4 / contracts.md §1.5）。
 *
 * 语义：BossFavorite = 测评后深度认可（完成面试/绩效/Arena 对决后对该工种某 agent 投票）。
 * 幂等：一次测评最多投一票（sourceId 幂等键），重复投票后端返回 409。
 *
 * 新拟物约定：实体墨色/实体色徽章 + --neu-ink/--neu-ink-soft 文字，
 * 禁止半透明彩底+彩字组合。
 */
import { useEffect, useState } from 'react';
import { Award, Crown, ThumbsUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getFavorites, voteFavorite } from '@/services/reactionStore';
import type { JobType } from '@/types/evaluation';
import type { FavoriteRanking } from '@/types/reactions';

export interface BossFavoriteBadgeProps {
  agentId: string;
  agentName?: string;
  jobType: JobType;
  /** 测评标识（interviewId/matchId），幂等键：同 agent+stage+sourceId 不可重复 */
  sourceId?: string;
  stage?: 'interview' | 'performance' | 'arena';
  /** 是否允许投票（测评完成页/市场页入口可投；纯展示时 false） */
  votable?: boolean;
  /** 展示模式：badge=仅徽章（Top1），rank=徽章+名次 */
  mode?: 'badge' | 'rank';
}

export function BossFavoriteBadge({
  agentId,
  jobType,
  sourceId,
  stage = 'arena',
  votable = false,
  mode = 'badge',
}: BossFavoriteBadgeProps) {
  const [ranking, setRanking] = useState<FavoriteRanking | null>(null);
  const [voted, setVoted] = useState(false);
  const [voting, setVoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getFavorites(jobType)
      .then((r) => {
        if (active) setRanking(r);
      })
      .catch(() => {
        if (active) setRanking(null);
      });
    return () => {
      active = false;
    };
  }, [jobType, voted]);

  const entry = ranking?.ranking.find((e) => e.agentId === agentId) ?? null;
  const rank = entry ? ranking!.ranking.indexOf(entry) + 1 : 0;
  const isTop1 = rank === 1;

  if (mode === 'badge' && !isTop1) return null;

  const handleVote = async () => {
    if (!votable || voting) return;
    setVoting(true);
    setError(null);
    try {
      const result = await voteFavorite({
        agentId,
        jobType,
        stage,
        sourceId,
        votedBy: 'default',
      });
      setVoted(result.voted);
      setVoting(false);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 409) {
        setError('该测评已投过票');
        setVoted(true);
      } else {
        setError(err.message ?? '投票失败');
      }
      setVoting(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      {isTop1 ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--neu-ink)] px-2 py-0.5 text-[10px] font-bold text-[var(--neu-surface)]">
          <Crown size={10} />
          最受 boss 青睐
        </span>
      ) : rank > 0 ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--neu-ink)]/90 px-2 py-0.5 text-[10px] font-bold text-[var(--neu-surface)]">
          <Award size={10} />
          #{rank}
        </span>
      ) : null}

      {votable && (
        <button
          type="button"
          onClick={() => void handleVote()}
          disabled={voting || voted}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold transition-colors',
            voted
              ? 'bg-[var(--neu-ink)] text-[var(--neu-surface)]'
              : 'bg-[var(--neu-surface)] text-[var(--neu-ink)] shadow-[3px_3px_6px_var(--neu-shadow-d),-3px_-3px_6px_var(--neu-shadow-l)] hover:opacity-80',
          )}
          title={voted ? '该测评已投过票' : '投一票（一次测评一票）'}
        >
          <ThumbsUp size={10} />
          {voted ? `${entry?.count ?? ''} 已投` : voting ? '投票中' : `投 ${(entry?.count ?? 0) + (voted ? 0 : 1)}`}
        </button>
      )}

      {!votable && entry && mode === 'rank' && (
        <span className="text-[10px] font-semibold tabular-nums text-[var(--neu-ink-soft)]">
          {entry.count} 票
        </span>
      )}

      {error && (
        <span className="text-[10px] text-[var(--neu-ink-soft)]" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

export default BossFavoriteBadge;
