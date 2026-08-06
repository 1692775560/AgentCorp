/**
 * src/components/evaluation/ConvergenceTrajectoryWidget.tsx
 * 「收敛轨迹」可视化（T18，复用 recharts + Tailwind，无新图表库）。
 *
 * 用 recharts 的 ScatterChart 把每轮 belief embedding 做 PCA 投到 2D，
 * 画出 S₀ → Turn1 → Turn2 → ... → 锚点 的「爬山」收敛过程：
 *   - 轨迹散点 + 折线（belief 序列，黄）；
 *   - 人类锚点单点（绿，人即梯度源落点）；
 *   - 残差连线（红虚线，末轮 belief → 锚点）；
 *   - 右上指标卡：convergence_score / CR / R / St / Rev / CQ。
 *
 * 注：架构 §5 提到「MUI+Tailwind」，本工程未安装 @mui，
 * 故复用既有 shadcn/Tailwind 组件（Card 等）以保持零新增依赖。
 */
import * as React from 'react';
import {
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type {
  ConvergenceTrace,
  ConvergenceScore,
  HumanAnchor,
} from '@/types/convergence';
import { computeConvergenceScore } from '@/engine/convergence/score';
import {
  pca2d,
  selectBeliefSequence,
  selectAnchorEmbedding,
} from '@/engine/convergence/pca';

interface ConvergenceTrajectoryWidgetProps {
  trace: ConvergenceTrace | null;
  /** 可选人工锚点（优先用其 embedding） */
  anchor?: HumanAnchor | null;
  /** 可选后端收敛分（缺则本地镜像公式兜底） */
  score?: ConvergenceScore | null;
  height?: number;
}

interface Point {
  x: number;
  y: number;
  name: string;
  kind: 'trajectory' | 'anchor';
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function PointLabel(props: any) {
  const { x, y, payload } = props;
  if (!payload || !payload.name) return null;
  return (
    <text
      x={Number(x) + 6}
      y={Number(y) - 6}
      fontSize={11}
      fill="#94a3b8"
      className="pointer-events-none select-none"
    >
      {payload.name}
    </text>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col rounded-lg bg-white/60 px-3 py-2 dark:bg-white/5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export function ConvergenceTrajectoryWidget({
  trace,
  anchor,
  score,
  height = 320,
}: ConvergenceTrajectoryWidgetProps) {
  const localScore = React.useMemo<ConvergenceScore | null>(() => {
    if (score) return score;
    if (trace) {
      try {
        return computeConvergenceScore(trace);
      } catch {
        return null;
      }
    }
    return null;
  }, [score, trace]);

  const { trajectoryPoints, anchorPoint, residualPoints } = React.useMemo(() => {
    const trajectory: Point[] = [];
    const anchorPt: Point[] = [];
    const residual: Point[] = [];
    if (!trace)
      return {
        trajectoryPoints: trajectory,
        anchorPoint: anchorPt,
        residualPoints: residual,
      };

    const beliefs = selectBeliefSequence(trace);
    const anchorEmb = anchor?.embedding ?? selectAnchorEmbedding(trace);
    const allVecs = anchorEmb ? [...beliefs, anchorEmb] : beliefs;
    const proj = pca2d(allVecs);

    beliefs.forEach((_: number[], i: number) => {
      const p = proj[i];
      if (!p) return;
      trajectory.push({
        x: p[0],
        y: p[1],
        name: i === 0 ? 'S₀' : `Turn${i}`,
        kind: 'trajectory',
      });
    });

    if (anchorEmb && proj.length > beliefs.length) {
      const a = proj[proj.length - 1];
      anchorPt.push({ x: a[0], y: a[1], name: '锚点(人工)', kind: 'anchor' });
      const lastBelief = proj[beliefs.length - 1];
      if (lastBelief) {
        residual.push(
          { x: lastBelief[0], y: lastBelief[1], name: '末轮', kind: 'trajectory' },
          { x: a[0], y: a[1], name: '锚点', kind: 'anchor' },
        );
      }
    }
    return {
      trajectoryPoints: trajectory,
      anchorPoint: anchorPt,
      residualPoints: residual,
    };
  }, [trace, anchor]);

  const noData = !trace || trajectoryPoints.length === 0;

  return (
    <Card className="w-full">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">收敛轨迹 · State-Space Convergence</CardTitle>
          {localScore ? (
            <span
              className={
                'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ' +
                (localScore.convergence_quality === 1
                  ? 'border-transparent bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100'
                  : 'border-transparent bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-100')
              }
            >
              {localScore.convergence_quality === 1 ? '已获人类背书' : '未获人类背书'}
            </span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {noData ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            暂无收敛轨迹数据（需先记录 S₀..K 各轮 belief embedding）
          </div>
        ) : (
          <div
            style={{ width: '100%', height }}
            className="rounded-2xl bg-white/40 p-2 dark:bg-white/5"
          >
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 16, right: 16, bottom: 16, left: 0 }}>
                <CartesianGrid stroke="rgba(148,163,184,0.25)" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="PC1"
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="PC2"
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  content={({ active, payload }) => {
                    if (!active || !payload || !payload.length) return null;
                    const p = payload[0].payload as Point;
                    return (
                      <div className="rounded-md border bg-background px-2 py-1 text-xs shadow">
                        <div className="font-medium">{p.name}</div>
                        <div className="text-muted-foreground">
                          PC1={p.x.toFixed(3)} · PC2={p.y.toFixed(3)}
                        </div>
                      </div>
                    );
                  }}
                />
                <Legend />
                {/* 残差连线（末轮 → 锚点） */}
                {residualPoints.length === 2 ? (
                  <Scatter
                    name="残差 R"
                    data={residualPoints}
                    fill="#ef4444"
                    line={{ stroke: '#ef4444', strokeDasharray: '4 4' }}
                    legendType="none"
                    isAnimationActive={false}
                  />
                ) : null}
                {/* 收敛轨迹（S₀ → Turn1..K） */}
                <Scatter
                  name="轨迹 (belief)"
                  data={trajectoryPoints}
                  fill="#FFD233"
                  line={{ stroke: '#FFD233' }}
                  label={<PointLabel />}
                  isAnimationActive={false}
                />
                {/* 人类锚点 */}
                {anchorPoint.length ? (
                  <Scatter
                    name="人类锚点"
                    data={anchorPoint}
                    fill="#22c55e"
                    shape="star"
                    label={<PointLabel />}
                    isAnimationActive={false}
                  />
                ) : null}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        )}

        {localScore ? (
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
            <Metric label="收敛分" value={localScore.convergence_score.toFixed(1)} hint="0–100" />
            <Metric label="收缩率 CR" value={localScore.contraction_rate.toFixed(3)} hint="1−|S_K|/|S_0|" />
            <Metric label="残差 R" value={localScore.residual.toFixed(3)} hint="越小越好" />
            <Metric label="稳定度 St" value={localScore.stability.toFixed(3)} />
            <Metric label="可逆性 Rev" value={localScore.reversibility.toFixed(3)} hint="防越权" />
            <Metric
              label="质量 CQ"
              value={localScore.convergence_quality === 1 ? '1' : '0'}
              hint="人类背书"
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default ConvergenceTrajectoryWidget;
