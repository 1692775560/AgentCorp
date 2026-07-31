/**
 * src/pages/Evaluation/RadarChart.tsx
 * 六维雷达图（task/quality/comm/creativity/reliability/cost）。
 * 使用 recharts 的 RadarChart，分值范围 0–5。
 */
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
} from 'recharts';

import type { RadarScore } from '@/types/evaluation';

export interface RadarChartProps {
  score: RadarScore | null;
  /** 对比基线（可选），用于叠加参考多边形 */
  baseline?: RadarScore | null;
  height?: number;
}

const DIM_LABELS: Record<keyof RadarScore, string> = {
  task: '任务',
  quality: '质量',
  comm: '沟通',
  creativity: '创意',
  reliability: '可靠',
  cost: '性价比',
};

/** 零分兜底，避免 score 为 null 时取值报错 */
const EMPTY_SCORE: RadarScore = {
  task: 0,
  quality: 0,
  comm: 0,
  creativity: 0,
  reliability: 0,
  cost: 0,
};

/** 雷达图单点：dim 为维度名，score 为主序列，baseline 为可选对比序列 */
interface RadarDatum {
  dim: string;
  score: number;
  baseline?: number;
}

/**
 * 将 RadarScore（及可选基线）转为 recharts 所需的一维序列。
 *
 * 注意：recharts 的 <Radar> 只接受 dataKey，不接受 data
 * （见 node_modules/recharts/types/polar/Radar.d.ts 的 RadarProps）。
 * 多序列叠加的正确做法是把所有序列合并进 <RadarChart data>，
 * 再由各 <Radar> 用不同 dataKey 取值。
 */
function toSeries(score: RadarScore | null, baseline?: RadarScore | null): RadarDatum[] {
  const s: RadarScore = score ?? EMPTY_SCORE;
  return (Object.keys(DIM_LABELS) as Array<keyof RadarScore>).map((dim) => ({
    dim: DIM_LABELS[dim],
    score: s[dim],
    ...(baseline ? { baseline: baseline[dim] } : {}),
  }));
}

export function RadarChartView({ score, baseline, height = 280 }: RadarChartProps) {
  const data = toSeries(score, baseline);
  const hasBaseline = Boolean(baseline);

  return (
    <div style={{ width: '100%', height }} className="rounded-2xl bg-white/60 p-3 dark:bg-white/5">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} outerRadius="72%">
          <PolarGrid stroke="rgba(148,163,184,0.35)" />
          <PolarAngleAxis dataKey="dim" tick={{ fill: '#94a3b8', fontSize: 12 }} />
          <PolarRadiusAxis
            angle={90}
            domain={[0, 5]}
            tick={{ fill: '#64748b', fontSize: 10 }}
            axisLine={false}
          />
          {hasBaseline ? (
            <Radar
              name="基线"
              dataKey="baseline"
              stroke="#94a3b8"
              fill="#94a3b8"
              fillOpacity={0.1}
              isAnimationActive={false}
            />
          ) : null}
          <Radar
            name="评分"
            dataKey="score"
            stroke="#FFD233"
            fill="#FFD233"
            fillOpacity={0.45}
            isAnimationActive
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default RadarChartView;
