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
import { useEffect, useMemo, useState } from 'react';
import { Loader2, MessagesSquare } from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { InterviewCandidatePanel } from '@/components/interview/InterviewCandidatePanel';
import { BossProfileSelector } from '@/components/persona/BossProfileSelector';
import { InterviewThread } from '@/components/interview/InterviewThread';
import { DimScoreboard } from '@/components/interview/DimScoreboard';
import { CraftTrialPanel } from '@/components/interview/CraftTrialPanel';
import { SubjectiveScorePanel } from '@/components/evaluation/SubjectiveScorePanel';
import { RadarChartView } from '@/pages/Evaluation/RadarChart';
import { aggregateHrRadar } from '@/engine/interview/dimTracker';
import { useInterviewStore, currentCoverageRatio } from '@/stores/interview';

/** 窄屏（< xl）下的三视图切换 */
type NarrowView = 'candidate' | 'thread' | 'assess';

const NARROW_VIEWS: Array<{ key: NarrowView; label: string }> = [
  { key: 'candidate', label: '① 选候选' },
  { key: 'thread', label: '② 面试对话' },
  { key: 'assess', label: '③ 测评结果' },
];

/** 面试主流程四步（顶部引导条） */
type FlowKey = 'pick' | 'ask' | 'judge' | 'archive';

const FLOW_STEPS: Array<{ key: FlowKey; label: string; hint: string }> = [
  { key: 'pick', label: '选候选并开场', hint: '在左栏挑一位已雇佣的员工，点「开始面试」。' },
  { key: 'ask', label: '问答并逐轮打分', hint: '点「让候选作答」，再给这一轮的表现打分。' },
  { key: 'judge', label: '跑大模型测评', hint: '到右栏「大模型测评」跑试做题，拿客观分。' },
  { key: 'archive', label: '归档评分卡', hint: '在左栏写结论并「结束面试并生成评分卡」。' },
];

/** 当前处在哪一步：done 划掉、active 高亮、todo 灰显 */
function flowState(
  key: FlowKey,
  status: string,
  hasTurns: boolean,
  hasJudged: boolean,
): 'done' | 'active' | 'todo' {
  const order: FlowKey[] = ['pick', 'ask', 'judge', 'archive'];
  const current: FlowKey =
    status === 'idle' ? 'pick' : status === 'finished' ? 'archive'
      : !hasTurns ? 'ask' : !hasJudged ? 'judge' : 'archive';
  const at = order.indexOf(key);
  const cur = order.indexOf(current);
  if (status === 'finished' && key === 'archive') return 'done';
  if (at < cur) return 'done';
  return at === cur ? 'active' : 'todo';
}

export function Interview() {
  const agentId = useInterviewStore((s) => s.agentId);
  const status = useInterviewStore((s) => s.status);
  const turns = useInterviewStore((s) => s.turns);
  const coverage = useInterviewStore((s) => s.coverage);
  const baselineRadar = useInterviewStore((s) => s.baselineRadar);
  const report = useInterviewStore((s) => s.report);
  const craftTrials = useInterviewStore((s) => s.craftTrials);
  const judgeRadar = useInterviewStore((s) => s.judgeRadar);
  const judgeSource = useInterviewStore((s) => s.judgeSource);
  const judging = useInterviewStore((s) => s.judging);
  const judgeError = useInterviewStore((s) => s.judgeError);
  const runJudge = useInterviewStore((s) => s.runJudge);

  /**
   * 实时六维：结束后用报告定稿值；面试中以模型分为底、HR 打过的维覆盖之。
   * 模型分不可用时只显示 HR 真实打过的分，不回落基线（避免 S1 印象分冒充面试分）。
   */
  const liveRadar = useMemo(
    () => report?.finalRadar ?? aggregateHrRadar(turns, judgeRadar) ?? judgeRadar,
    [report, turns, judgeRadar],
  );
  const ratio = useMemo(() => currentCoverageRatio(coverage), [coverage]);

  const hasTurns = turns.length > 0;
  // 「已测评」= 对话已被模型评审过，或试做题已出分（两条模型分通路任一即可）
  const hasJudged = judgeRadar !== null || craftTrials.some((t) => t.judgement !== null);

  const [narrowView, setNarrowView] = useState<NarrowView>('candidate');

  /** 窄屏下让视图跟随阶段走：开场 → 对话，评分/归档 → 测评。
      宽屏三栏并列，这个状态不影响渲染。
      P2 修复：此前 `scoring` 态无分支，窄屏会停在 candidate 视图盲区（收尾按钮已在左栏却看不到测评推进）。 */
  useEffect(() => {
    if (status === 'running') setNarrowView('thread');
    else if (status === 'finished' || status === 'scoring') setNarrowView('assess');
    else if (status === 'idle') setNarrowView('candidate');
  }, [status]);

  return (
    <div className="tech-bg flex h-full flex-col overflow-hidden">
      {/* 页头 */}
      <header className="flex shrink-0 items-center gap-2 border-b border-white/60 bg-white/45 px-4 py-3 backdrop-blur dark:bg-white/5">
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

      {/* 流程引导条：面试是「选人 → 问答打分 → 跑大模型测评 → 归档」四步，
          此前用户只看到三栏面板，不知道从哪下手，也不知道自己走到了第几步。 */}
      <ol className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-white/60 bg-white/30 px-4 py-2 text-[11px] backdrop-blur dark:bg-white/5">
        {FLOW_STEPS.map((step, i) => {
          const state = flowState(step.key, status, hasTurns, hasJudged);
          return (
            <li key={step.key} className="flex items-center gap-2">
              {i > 0 && <span className="text-muted-foreground/50">›</span>}
              <span
                className={
                  state === 'active'
                    ? 'rounded-full bg-[#FFD233]/25 px-2 py-0.5 font-semibold text-foreground'
                    : state === 'done'
                      ? 'text-muted-foreground line-through decoration-muted-foreground/40'
                      : 'text-muted-foreground'
                }
                title={step.hint}
              >
                {i + 1}. {step.label}
              </span>
            </li>
          );
        })}
        <li className="ml-auto text-muted-foreground">
          {FLOW_STEPS.find((s) => flowState(s.key, status, hasTurns, hasJudged) === 'active')?.hint}
        </li>
      </ol>

      {/* 窄屏视图切换：窄屏下三栏无法并列，用页签保证「选人 / 对话 / 测评」都可达。
          此前左栏 lg:block、右栏 xl:block 会在窄窗口同时隐藏，
          导致「开始面试」入口和测评结果一起消失，中栏却仍提示「左侧选择候选」。 */}
      <div className="flex shrink-0 gap-1 border-b border-white/60 bg-white/35 px-3 py-2 backdrop-blur xl:hidden dark:bg-white/5">
        {NARROW_VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => setNarrowView(v.key)}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
              narrowView === v.key
                ? 'bg-[#FFD233]/20 text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-white/50 dark:hover:bg-white/10'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* 三栏主体 */}
      <div className="flex min-h-0 flex-1">
        {/* 左栏：宽屏常驻，窄屏受页签控制 */}
        <aside
          className={`${narrowView === 'candidate' ? 'flex' : 'hidden'} w-full min-w-0 shrink-0 flex-col border-r border-white/50 bg-white/35 backdrop-blur-xl xl:flex xl:w-72 dark:bg-white/5`}
        >
          {/* A · 老板原型选择器：决定面试选题的「与谁协作」视角（顶部常驻） */}
          <div className="shrink-0 p-3 pb-0">
            <BossProfileSelector />
          </div>
          <InterviewCandidatePanel />
        </aside>

        {/* 中栏 */}
        <main
          className={`${narrowView === 'thread' ? 'block' : 'hidden'} min-w-0 flex-1 xl:block`}
        >
          <InterviewThread />
        </main>

        {/* 右栏 */}
        <aside
          className={`${narrowView === 'assess' ? 'block' : 'hidden'} w-full min-w-0 shrink-0 border-l border-white/50 bg-white/35 backdrop-blur-xl xl:block xl:w-80 dark:bg-white/5`}
        >
          {/* 页签按「谁在打分」收成两个：大模型测评（主线，默认展开）+ 我的打分。
              此前「大模型测评 / 能力画像 / 我的偏好」平铺，用户分不清哪个是模型给的、哪个要自己动手；
              收敛轨迹仍归评估中心的「收敛」面板，面试期不重复呈现。 */}
          <Tabs defaultValue="model" className="flex h-full flex-col">
            <TabsList className="mx-3 mt-3 grid w-auto grid-cols-2">
              <TabsTrigger value="model">大模型测评</TabsTrigger>
              <TabsTrigger value="mine">我的打分</TabsTrigger>
            </TabsList>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <TabsContent value="model" className="mt-0 space-y-4">
                <CraftTrialPanel />
                <div className="space-y-2 border-t border-white/50 pt-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">面试期六维</h3>
                    {judging && (
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        模型评审中
                      </span>
                    )}
                    {!judging && judgeRadar !== null && (
                      <Badge variant="outline" className="text-[10px]">
                        {judgeSource === 'judge'
                          ? '模型评审'
                          : judgeSource === 'mixed'
                            ? '模型评审（部分降级）'
                            : '启发式降级'}
                      </Badge>
                    )}
                    {hasTurns && !judging && (
                      <button
                        type="button"
                        onClick={() => void runJudge()}
                        className="ml-auto text-[11px] text-muted-foreground underline hover:text-foreground"
                      >
                        重新评审
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    实线 = 模型评审为底、你的打分覆盖之；虚线 = 入场基线（S1 初审 / 历史评估）。
                  </p>
                  <RadarChartView score={liveRadar} baseline={baselineRadar} height={260} />
                  {judgeError !== null && (
                    <p className="text-[11px] text-orange-600 dark:text-orange-400">{judgeError}</p>
                  )}
                  {liveRadar === null && judgeError === null && (
                    <p className="text-[11px] text-muted-foreground">
                      尚无评分数据：让候选答完第一题后，模型会自动评审并在此显示。
                    </p>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="mine" className="mt-0 space-y-4">
                <DimScoreboard coverage={coverage} ratio={ratio} turnCount={turns.length} />
                {agentId ? (
                  <SubjectiveScorePanel agentId={agentId} stage="interview" />
                ) : (
                  <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                    开始面试后可对本阶段主观维打分，分数会并入 S2 评分卡。
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
