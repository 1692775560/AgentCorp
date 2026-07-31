/**
 * src/pages/Interview/index.tsx
 * HR 面试（S2）三栏工作台（模块 B · 设计 §4.1 / §4.2）。
 *
 * 布局：
 *   左｜候选与场次控制台（任务画像 = ★通道① 的输入证据）
 *   中｜面试对话主轴（三阶段递进题序 + 追问建议 = 对话式收敛的操作面）
 *   右｜实时评估（维度覆盖看板 / 主观打分 / 收敛轨迹 / 六维雷达）
 *
 * 三阶段流水线中的位置：S1 人才市场初审 → 【S2 面试】 → S3 绩效考核，
 * 面试结束时把报告写进 EvaluationProfile.interviewBaseline（★通道②），
 * 绩效侧据此对比「面试期承诺 vs 上岗后实际」。
 */
import { useMemo } from 'react';
import { MessagesSquare } from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { InterviewCandidatePanel } from '@/components/interview/InterviewCandidatePanel';
import { InterviewThread } from '@/components/interview/InterviewThread';
import { DimScoreboard } from '@/components/interview/DimScoreboard';
import { SubjectiveScorePanel } from '@/components/evaluation/SubjectiveScorePanel';
import { ConvergenceTrajectoryWidget } from '@/components/evaluation/ConvergenceTrajectoryWidget';
import { RadarChartView } from '@/pages/Evaluation/RadarChart';
import { aggregateHrRadar } from '@/engine/interview/dimTracker';
import { useInterviewStore, currentCoverageRatio } from '@/stores/interview';
import { useConvergenceStore } from '@/stores/convergenceStore';

export function Interview() {
  const agentId = useInterviewStore((s) => s.agentId);
  const status = useInterviewStore((s) => s.status);
  const turns = useInterviewStore((s) => s.turns);
  const coverage = useInterviewStore((s) => s.coverage);
  const baselineRadar = useInterviewStore((s) => s.baselineRadar);
  const report = useInterviewStore((s) => s.report);

  const trace = useConvergenceStore((s) => s.trace);
  const convergenceScore = useConvergenceStore((s) => s.score);
  const explicitPin = useConvergenceStore((s) => s.explicitPin);

  /** 实时六维：面试中用 HR 打分聚合，结束后用报告定稿值 */
  const liveRadar = useMemo(
    () => report?.finalRadar ?? aggregateHrRadar(turns, baselineRadar),
    [report, turns, baselineRadar],
  );
  const ratio = useMemo(() => currentCoverageRatio(coverage), [coverage]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* 页头 */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <MessagesSquare className="h-5 w-5 text-[#FFD233]" />
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold text-foreground">HR 面试 · S2</h1>
          <p className="truncate text-xs text-muted-foreground">
            用结构化多轮提问，把模糊需求收敛成可量化的能力评估
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Badge variant={status === 'finished' ? 'success' : status === 'idle' ? 'outline' : 'default'}>
            {status === 'idle' && '待开始'}
            {status === 'running' && '面试中'}
            {status === 'scoring' && '评分中'}
            {status === 'finished' && '已归档'}
          </Badge>
          <Badge variant="outline" className="tabular-nums">
            覆盖 {Math.round(ratio * 100)}%
          </Badge>
        </div>
      </header>

      {/* 三栏主体 */}
      <div className="flex min-h-0 flex-1">
        {/* 左栏 */}
        <aside className="hidden w-72 shrink-0 border-r border-border bg-muted/20 lg:block">
          <InterviewCandidatePanel />
        </aside>

        {/* 中栏 */}
        <main className="min-w-0 flex-1">
          <InterviewThread />
        </main>

        {/* 右栏 */}
        <aside className="hidden w-80 shrink-0 border-l border-border bg-muted/20 xl:block">
          <Tabs defaultValue="coverage" className="flex h-full flex-col">
            <TabsList className="mx-3 mt-3 grid w-auto grid-cols-3">
              <TabsTrigger value="coverage">覆盖</TabsTrigger>
              <TabsTrigger value="subjective">主观</TabsTrigger>
              <TabsTrigger value="radar">画像</TabsTrigger>
            </TabsList>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <TabsContent value="coverage" className="mt-0 space-y-4">
                <DimScoreboard coverage={coverage} ratio={ratio} turnCount={turns.length} />
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">收敛轨迹</h3>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    每一轮回答都会把「认知置信向量」推进一步，点越收拢代表对候选能力的判断越确定。
                  </p>
                  <ConvergenceTrajectoryWidget
                    trace={trace}
                    anchor={explicitPin}
                    score={convergenceScore}
                    height={220}
                  />
                </div>
              </TabsContent>

              <TabsContent value="subjective" className="mt-0">
                {agentId ? (
                  <SubjectiveScorePanel agentId={agentId} stage="interview" />
                ) : (
                  <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                    开始面试后可对本阶段主观维打分，分数会并入 S2 评分卡。
                  </p>
                )}
              </TabsContent>

              <TabsContent value="radar" className="mt-0 space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">面试期六维</h3>
                  <p className="text-[11px] text-muted-foreground">
                    实线 = HR 逐轮打分聚合；虚线 = 入场基线（S1 初审 / 历史评估）。
                  </p>
                </div>
                <RadarChartView score={liveRadar} baseline={baselineRadar} height={260} />
                {liveRadar === null && (
                  <p className="text-[11px] text-muted-foreground">
                    尚无评分数据：在中栏对每轮回答打分后，此处即时更新。
                  </p>
                )}
              </TabsContent>
            </div>
          </Tabs>
        </aside>
      </div>
    </div>
  );
}

export default Interview;
