/**
 * src/components/evaluation/DualTrackScoreCard.tsx
 * S3 双轨评分卡（T40，增量 §3.3 dual 面板）。
 *
 * - 客观轨：KPI / ROI / token 用量 / 返工率 / 任务完成度 / 思考时延 指标条，
 *   数据来自 EvaluationProfile.kpiLatest + roiLatest（真实遥测聚合，不掺主观）。
 * - 主观轨：SubjectiveScorePanel(stage="performance")（用户主观分，O8 红线内）。
 * - 加权综合 total：
 *   · 权威值 = scoringStore.stageScores[agentId]（stage=performance）的 StageScore.total；
 *   · 本地预览 = 0.7×客观合成 + 0.3×主观均值×20（S3 preset obj/sub=0.7/0.3），
 *     其中客观合成按 scoringStore.userWeight（用户心智权重）对六维加权 →
 *     「绩效 → 市场权重回灌」链路（§7.3）在双轨卡上的可见化。
 */
import { useMemo } from 'react';
import { Scale } from 'lucide-react';

import { SubjectiveScorePanel } from '@/components/evaluation/SubjectiveScorePanel';
import { useEvaluationStore } from '@/stores/evaluation';
import { useScoringStore } from '@/stores/scoringStore';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import type { RadarDim, StageScore } from '@/types/evaluation';

interface Props {
  /** 目标 agent（null = 未选中，渲染占位） */
  agentId: string | null;
}

/** S3 阶段权重（后端 rules preset 钉死：obj/sub = 0.7/0.3，仅展示不另写阈值） */
const S3_OBJECTIVE_WEIGHT = 0.7;
const S3_SUBJECTIVE_WEIGHT = 0.3;

/** 单条客观指标条（value ∈ [0,1]，invert=true 表示越低越好） */
function MetricBar({
  label,
  display,
  ratio,
  invert = false,
}: {
  label: string;
  display: string;
  ratio: number | null;
  invert?: boolean;
}) {
  const pct = ratio == null ? 0 : Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  // 越低越好的指标（返工率等）用「好度」= 1 − ratio 上色
  const goodness = invert ? 100 - pct : pct;
  const barCls =
    goodness >= 70 ? 'bg-emerald-400' : goodness >= 40 ? 'bg-[#FFD233]' : 'bg-rose-400';
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-semibold text-gray-500 dark:text-gray-300">{label}</span>
        <span className="font-bold tabular-nums text-[#1A1C1E] dark:text-white">{display}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-200/70 dark:bg-white/10">
        <div
          className={`h-full rounded-full transition-all ${barCls}`}
          style={{ width: `${ratio == null ? 0 : pct}%` }}
        />
      </div>
    </div>
  );
}

export function DualTrackScoreCard({ agentId }: Props) {
  const profile = useEvaluationStore((s) => (agentId ? s.profiles[agentId] : undefined));
  const stageScore = useScoringStore((s) =>
    agentId ? (s.stageScores[agentId] as StageScore | undefined) : undefined,
  );
  const userWeight = useScoringStore((s) => s.userWeight);
  const subjective = useScoringStore((s) =>
    agentId ? s.subjectiveScores[`performance:${agentId}`] : undefined,
  );

  const kpi = profile?.kpiLatest ?? null;
  const roi = profile?.roiLatest ?? null;
  const radar = profile?.radarLatest ?? null;

  /** 客观合成（0–100）：六维 × 用户心智权重（Σ=1，无雷达时 null） */
  const objectiveComposite = useMemo(() => {
    if (!radar) return null;
    let sum = 0;
    let wSum = 0;
    for (const d of RADAR_DIMS as RadarDim[]) {
      const w = userWeight[d] ?? 0;
      sum += (radar[d] / 5) * w;
      wSum += w;
    }
    if (wSum <= 0) return null;
    return (sum / wSum) * 100;
  }, [radar, userWeight]);

  /** 主观均值（0–100）：sub_* 均值 × 20（无打分时 null） */
  const subjectiveComposite = useMemo(() => {
    const values = Object.values(subjective ?? {}).filter(
      (v): v is number => typeof v === 'number',
    );
    if (values.length === 0) return null;
    return (values.reduce((a, b) => a + b, 0) / values.length) * 20;
  }, [subjective]);

  /** 本地预览 total（0.7/0.3 加权；缺任一轨时以另一轨兜底） */
  const previewTotal = useMemo(() => {
    if (objectiveComposite == null && subjectiveComposite == null) return null;
    const obj = objectiveComposite ?? 0;
    const sub = subjectiveComposite ?? 0;
    if (objectiveComposite == null) return sub;
    if (subjectiveComposite == null) return obj;
    return S3_OBJECTIVE_WEIGHT * obj + S3_SUBJECTIVE_WEIGHT * sub;
  }, [objectiveComposite, subjectiveComposite]);

  /** 权威 total：仅采信 stage=performance 的评分卡 */
  const authoritative =
    stageScore && stageScore.stage === 'performance' ? stageScore : null;
  const total = authoritative ? authoritative.total : previewTotal;

  if (!agentId) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">
        从左侧选择一个 agent 查看 S3 双轨评分。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 加权综合 total */}
      <div className="flex items-center justify-between rounded-2xl border border-white/40 bg-white/60 p-4 dark:bg-white/5">
        <div className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-[#FFD233]" />
          <div>
            <p className="text-[13px] font-bold text-[#1A1C1E] dark:text-white">
              S3 加权综合分
            </p>
            <p className="text-[11px] text-gray-400">
              客观 {Math.round(S3_OBJECTIVE_WEIGHT * 100)}% + 主观{' '}
              {Math.round(S3_SUBJECTIVE_WEIGHT * 100)}%（rules preset）·{' '}
              {authoritative ? '来源：/api/evaluate-stage 评分卡' : '本地预览（未装配评分卡）'}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-2xl font-extrabold tabular-nums text-[#1A1C1E] dark:text-white">
            {total == null ? '—' : total.toFixed(1)}
          </p>
          {authoritative ? (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                authoritative.verdict === 'MVP'
                  ? 'bg-[#FFD233] text-[#1A1C1E]'
                  : authoritative.verdict === 'OBSERVE'
                    ? 'bg-sky-100 text-sky-700'
                    : 'bg-rose-500 text-white'
              }`}
            >
              {authoritative.verdict}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        {/* 客观轨 */}
        <section className="min-w-[280px] flex-1 space-y-3 rounded-2xl border border-white/40 bg-white/60 p-4 dark:bg-white/5">
          <div>
            <h3 className="text-[13px] font-bold text-[#1A1C1E] dark:text-white">
              客观轨 · 真实遥测
            </h3>
            <p className="text-[11px] text-gray-400">
              来自 KPI/ROI 聚合（不掺主观）· 客观合成{' '}
              <span className="font-bold text-[#1A1C1E] dark:text-white">
                {objectiveComposite == null ? '—' : objectiveComposite.toFixed(1)}
              </span>
              （六维 × 用户心智权重）
            </p>
          </div>
          {kpi || roi ? (
            <div className="space-y-2.5">
              <MetricBar
                label="任务完成度 TCR"
                display={kpi ? `${(kpi.task_completion_rate * 100).toFixed(0)}%` : '—'}
                ratio={kpi ? kpi.task_completion_rate : null}
              />
              <MetricBar
                label="一次成功率 FSR"
                display={kpi ? `${(kpi.first_success_rate * 100).toFixed(0)}%` : '—'}
                ratio={kpi ? kpi.first_success_rate : null}
              />
              <MetricBar
                label="返工率 RR（越低越好）"
                display={kpi ? `${(kpi.rework_rate * 100).toFixed(0)}%` : '—'}
                ratio={kpi ? kpi.rework_rate : null}
                invert
              />
              <MetricBar
                label="思考/交付时延 ADL"
                display={kpi ? `${(kpi.avg_delivery_latency_ms / 1000).toFixed(1)}s` : '—'}
                // 归一：60s 记满格（越长越差）
                ratio={kpi ? Math.min(1, kpi.avg_delivery_latency_ms / 60_000) : null}
                invert
              />
              <MetricBar
                label="token 成本当量 C_total"
                display={roi ? roi.cost_total.toFixed(1) : '—'}
                // 归一：以价值当量为参照，成本占比越高越差
                ratio={
                  roi && roi.cost_total + roi.value_total > 0
                    ? roi.cost_total / (roi.cost_total + roi.value_total)
                    : null
                }
                invert
              />
              <MetricBar
                label="ROI（性价比 0–5 归一）"
                display={roi ? roi.roi.toFixed(2) : '—'}
                ratio={roi ? roi.cost_perf_score / 5 : null}
              />
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-gray-300 px-3 py-4 text-center text-[12px] text-gray-400">
              暂无客观遥测。请先在左侧「运行评估」。
            </p>
          )}
        </section>

        {/* 主观轨（复用重写版打分面板，行为不变） */}
        <section className="min-w-[280px] flex-1">
          <SubjectiveScorePanel agentId={agentId} stage="performance" />
          <p className="mt-2 px-1 text-[11px] text-gray-400">
            主观合成{' '}
            <span className="font-bold text-[#1A1C1E] dark:text-white">
              {subjectiveComposite == null ? '—' : subjectiveComposite.toFixed(1)}
            </span>
            （sub_* 均值 × 20）· 打分即产生偏好信号，回灌用户心智权重。
          </p>
        </section>
      </div>
    </div>
  );
}

export default DualTrackScoreCard;
