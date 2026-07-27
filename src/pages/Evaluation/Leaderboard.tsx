/**
 * src/pages/Evaluation/Leaderboard.tsx
 * 擂台排名：列出全部 agent 的 ROI 排名，末位（BOTTOM）以 FIRED 标记呈现。
 */
import type { LeaderboardEntry } from '@/types/evaluation';

export interface LeaderboardProps {
  entries: LeaderboardEntry[];
  selectedAgentId: string | null;
  onSelect: (agentId: string) => void;
}

const TIER_BADGE: Record<LeaderboardEntry['tier'], { label: string; cls: string }> = {
  MVP: { label: 'MVP', cls: 'bg-[#FFD233] text-[#1A1C1E]' },
  NORMAL: { label: '在岗', cls: 'bg-white/60 text-gray-500 dark:bg-white/10' },
  BOTTOM: { label: 'FIRED ▼', cls: 'bg-rose-500 text-white' },
};

export function Leaderboard({ entries, selectedAgentId, onSelect }: LeaderboardProps) {
  if (entries.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">
        暂无排名。运行评估后将基于 ROI 生成擂台。
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-white/40 bg-white/70 dark:bg-white/5">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-white/40 text-[11px] uppercase tracking-wider text-gray-400">
            <th className="px-4 py-2 font-bold">#</th>
            <th className="px-4 py-2 font-bold">Agent</th>
            <th className="px-4 py-2 font-bold">契合</th>
            <th className="px-4 py-2 font-bold">ROI z</th>
            <th className="px-4 py-2 font-bold">状态</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const badge = TIER_BADGE[e.tier];
            const selected = e.agentId === selectedAgentId;
            return (
              <tr
                key={e.agentId}
                onClick={() => onSelect(e.agentId)}
                className={`cursor-pointer border-b border-white/30 transition-colors last:border-0 ${
                  selected ? 'bg-[#FFD233]/15' : 'hover:bg-white/40 dark:hover:bg-white/10'
                }`}
              >
                <td className="px-4 py-2.5 font-bold text-[#1A1C1E] dark:text-white">{e.rank}</td>
                <td className="px-4 py-2.5 font-semibold text-[#1A1C1E] dark:text-white">{e.name}</td>
                <td className="px-4 py-2.5 text-gray-500 dark:text-gray-300">{e.user_fit}</td>
                <td className="px-4 py-2.5 text-gray-500 dark:text-gray-300">
                  {typeof e.roi_norm === 'number' ? e.roi_norm.toFixed(2) : '—'}
                </td>
                <td className="px-4 py-2.5">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${badge.cls}`}>
                    {badge.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default Leaderboard;
