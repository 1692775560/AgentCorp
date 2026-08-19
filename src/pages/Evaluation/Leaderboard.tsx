/**
 * src/pages/Evaluation/Leaderboard.tsx
 * 擂台排名：列出全部 agent 的 ROI 排名，末位（BOTTOM）以 FIRED 标记呈现。
 *
 * 来源分区（透明披露）：只有「真实裁判」与「部分降级」的条目参与正式排名；
 * 完全降级（judge_source==='degraded'，即外部裁判不可达时的离线回退）的条目
 * 单独列在下方灰色区块，不给名次、不与真实评测并列比较——
 * 未经模型评测的分数没有资格进榜，这是本项目「结论可复核」主张的底线。
 *
 * i18n：表头与 tier 徽章走 common:evaluation.leaderboard.*。
 */
import { useTranslation } from 'react-i18next';

import type { LeaderboardEntry } from '@/types/evaluation';

export interface LeaderboardProps {
  entries: LeaderboardEntry[];
  selectedAgentId: string | null;
  onSelect: (agentId: string) => void;
}

const TIER_CLS: Record<LeaderboardEntry['tier'], string> = {
  MVP: 'bg-[#FFD233] text-[#1A1C1E]',
  NORMAL: 'bg-white/60 text-gray-500 dark:bg-white/10',
  BOTTOM: 'bg-rose-500 text-white',
};

/** 来源徽章：judge 不额外标注（默认态），mixed / degraded 显式提示 */
const SOURCE_BADGE: Record<'mixed' | 'degraded', { label: string; cls: string }> = {
  mixed: { label: '部分降级', cls: 'bg-amber-400/20 text-amber-700 dark:text-amber-300' },
  degraded: { label: '未经评测', cls: 'bg-gray-400/20 text-gray-500 dark:text-gray-400' },
};

/** 完全降级的条目不进正式榜（判定依据集中在此，便于单测复用） */
export function isDegradedEntry(entry: LeaderboardEntry): boolean {
  return entry.judge_source === 'degraded';
}

export function Leaderboard({ entries, selectedAgentId, onSelect }: LeaderboardProps) {
  const { t } = useTranslation('common');

  if (entries.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">
        {t('evaluation.leaderboard.empty', '暂无排名。运行评估后将基于 ROI 生成擂台。')}
      </div>
    );
  }

  const ranked = entries.filter((e) => !isDegradedEntry(e));
  const degraded = entries.filter(isDegradedEntry);

  const renderRow = (e: LeaderboardEntry, opts: { showRank: boolean }) => {
    const selected = e.agentId === selectedAgentId;
    const badgeLabel =
      e.tier === 'MVP'
        ? 'MVP'
        : e.tier === 'BOTTOM'
          ? t('evaluation.leaderboard.tierBottom', 'FIRED ▼')
          : t('evaluation.leaderboard.tierNormal', '在岗');
    const source =
      e.judge_source === 'mixed' || e.judge_source === 'degraded'
        ? SOURCE_BADGE[e.judge_source]
        : null;
    return (
      <tr
        key={e.agentId}
        onClick={() => onSelect(e.agentId)}
        className={`cursor-pointer border-b border-white/30 transition-colors last:border-0 ${
          selected ? 'bg-[#FFD233]/15' : 'hover:bg-white/40 dark:hover:bg-white/10'
        }`}
      >
        <td className="px-4 py-2.5 font-bold text-[#1A1C1E] dark:text-white">
          {opts.showRank ? e.rank : '—'}
        </td>
        <td className="px-4 py-2.5 font-semibold text-[#1A1C1E] dark:text-white">
          {e.name}
          {source && (
            <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-bold ${source.cls}`}>
              {source.label}
            </span>
          )}
        </td>
        <td className="px-4 py-2.5 text-gray-500 dark:text-gray-300">{e.user_fit}</td>
        <td className="px-4 py-2.5 text-gray-500 dark:text-gray-300">
          {typeof e.roi_norm === 'number' ? e.roi_norm.toFixed(2) : '—'}
        </td>
        <td className="px-4 py-2.5">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${TIER_CLS[e.tier]}`}>
            {badgeLabel}
          </span>
        </td>
      </tr>
    );
  };

  const header = (
    <thead>
      <tr className="border-b border-white/40 text-[11px] uppercase tracking-wider text-gray-400">
        <th className="px-4 py-2 font-bold">#</th>
        <th className="px-4 py-2 font-bold">Agent</th>
        <th className="px-4 py-2 font-bold">{t('evaluation.leaderboard.colFit', '契合')}</th>
        <th className="px-4 py-2 font-bold">ROI z</th>
        <th className="px-4 py-2 font-bold">{t('evaluation.leaderboard.colStatus', '状态')}</th>
      </tr>
    </thead>
  );

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-2xl border border-white/40 bg-white/70 dark:bg-white/5">
        <table className="w-full text-left text-[13px]">
          {header}
          <tbody>
            {ranked.length > 0 ? (
              ranked.map((e) => renderRow(e, { showRank: true }))
            ) : (
              <tr>
                <td colSpan={5} className="px-4 py-4 text-center text-[12px] text-gray-400">
                  {t(
                    'evaluation.leaderboard.noJudged',
                    '尚无经真实裁判评测的条目。配置裁判后端后重新评估即可进榜。',
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {degraded.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-dashed border-gray-300/70 bg-gray-500/5">
          <p className="px-4 pt-3 text-[11px] leading-relaxed text-gray-500">
            {t(
              'evaluation.leaderboard.degradedNote',
              '以下条目未经模型评测（裁判后端不可达时的离线回退），不参与排名，仅供查看。',
            )}
          </p>
          <table className="w-full text-left text-[13px] opacity-70">
            {header}
            <tbody>{degraded.map((e) => renderRow(e, { showRank: false }))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default Leaderboard;
