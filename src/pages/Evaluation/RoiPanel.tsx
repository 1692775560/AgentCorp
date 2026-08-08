/**
 * src/pages/Evaluation/RoiPanel.tsx
 * ROI / 效率面板：展示 RoiSnapshot 的四项核心指标
 * （ROI / IPR / SRPC / CPS）以及成本/价值当量。
 *
 * i18n：指标 hint 与当量标签走 common:evaluation.*。
 */
import { useTranslation } from 'react-i18next';

import type { RoiSnapshot } from '@/types/evaluation';

export interface RoiPanelProps {
  roi: RoiSnapshot | null;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-white/40 bg-white/70 p-4 dark:bg-white/5">
      <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-gray-400">{label}</div>
      <div className="mt-1 text-2xl font-extrabold text-[#1A1C1E] dark:text-white">{value}</div>
      {hint ? <div className="mt-1 text-[11px] text-gray-400">{hint}</div> : null}
    </div>
  );
}

export function RoiPanel({ roi }: RoiPanelProps) {
  const { t } = useTranslation('common');

  if (!roi) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">
        {t('evaluation.roiEmpty', '暂无 ROI 数据。运行一次评估后将基于真实 token 用量计算。')}
      </div>
    );
  }

  const roiPct = (roi.roi * 100).toFixed(1);
  const roiColor = roi.roi >= 0 ? 'text-emerald-600' : 'text-rose-500';

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="ROI" value={`${roiPct}%`} hint={t('evaluation.roiHint', '(价值−成本)/成本')} />
        <Metric label="IPR" value={roi.ipr.toFixed(2)} hint={t('evaluation.iprHint', '投入产出比 V/C')} />
        <Metric label="SRPC" value={roi.srpc.toFixed(3)} hint={t('evaluation.srpcHint', '单位成本成功率')} />
        <Metric label="CPS" value={roi.cost_perf_score.toFixed(2)} hint={t('evaluation.cpsHint', '性价比分 0–5')} />
      </div>
      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <div className="rounded-2xl bg-white/60 p-3 dark:bg-white/5">
          <span className="text-gray-400">{t('evaluation.costEquiv', '成本当量 C')}</span>
          <div className="font-bold text-[#1A1C1E] dark:text-white">{roi.cost_total.toFixed(4)}</div>
        </div>
        <div className="rounded-2xl bg-white/60 p-3 dark:bg-white/5">
          <span className="text-gray-400">{t('evaluation.valueEquiv', '价值当量 V')}</span>
          <div className="font-bold text-[#1A1C1E] dark:text-white">{roi.value_total.toFixed(4)}</div>
        </div>
        <div className="rounded-2xl bg-white/60 p-3 dark:bg-white/5">
          <span className="text-gray-400">{t('evaluation.roiIndex', '相对基线 ROI_index')}</span>
          <div className="font-bold text-[#1A1C1E] dark:text-white">{roi.roi_index.toFixed(2)}</div>
        </div>
        <div className="rounded-2xl bg-white/60 p-3 dark:bg-white/5">
          <span className="text-gray-400">{t('evaluation.zscore', '群体 z-score')}</span>
          <div className={`font-bold ${roiColor}`}>
            {typeof roi.roi_norm === 'number' ? roi.roi_norm.toFixed(2) : '—'}
          </div>
        </div>
      </div>
    </div>
  );
}

export default RoiPanel;
