/**
 * src/components/interview/InterviewCandidatePanel.tsx
 * 面试候选与场次控制台（模块 B）。
 *
 * 三块内容：
 * 1) 任务需求卡 —— ★通道①（市场能力标签 → 面试考查维度）的输入与可视化证据：
 *    未开场时可直接编辑需求文本 / 工种（写回 marketplaceStore，与人才市场同一份真相），
 *    开场后转为只读展示。需求 + 被强调的六维正是 selectQuestions 用来排题序的输入。
 * 2) 候选列表 —— 选人 + 开场（带上 mainSessionKey 才能真实调度作答）。
 * 3) 收尾区 —— 面试结论 + 备注 → finishSession（S2 评分卡 + 报告落库 + 基线回灌）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, CheckCircle2, Loader2, RefreshCw, Sparkles, UserCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { boostedDims } from '@/engine/interview/questionBank';
import { RADAR_DIM_LABELS } from '@/engine/marketplace/radarSource';
import { inferJobType } from '@/engine/marketplace/taskMatch';
import { useAgentsStore } from '@/stores/agents';
import { useMarketplaceStore } from '@/stores/marketplace';
import { useInterviewStore } from '@/stores/interview';
import type { InterviewRecommendation } from '@/types/interview';
import type { JobType } from '@/types/evaluation';

/** 工种中文标签 */
const JOB_LABELS: Record<JobType, string> = {
  image: '图像',
  text: '文本',
  code: '代码',
};

/**
 * 候选自身的工种：从人设 / 职责 / 名称推断。
 *
 * 此前 startSession 未传 jobType，一路落到 `?? 'code'` 兜底，
 * 于是画师和文案也按写代码出题 —— 题目与工种完全不匹配。
 * 优先级：需求卡显式选择 > 候选自身画像 > 需求文本推断 > code。
 */
function inferCandidateJob(agent: {
  name: string;
  persona: string;
  responsibility: string;
}): JobType | null {
  return inferJobType(`${agent.name} ${agent.persona} ${agent.responsibility}`);
}

/** 面试结论选项 */
const RECOMMENDATION_OPTIONS: Array<{ value: InterviewRecommendation | 'auto'; label: string }> = [
  { value: 'auto', label: '自动判定（按评分卡）' },
  { value: 'hire', label: '录用 hire' },
  { value: 'hold', label: '待定 hold' },
  { value: 'reject', label: '不录用 reject' },
];

/** 结论 → 徽章样式 */
const RECOMMENDATION_TONE: Record<InterviewRecommendation, 'success' | 'warning' | 'destructive'> = {
  hire: 'success',
  hold: 'warning',
  reject: 'destructive',
};

const RECOMMENDATION_TEXT: Record<InterviewRecommendation, string> = {
  hire: '录用',
  hold: '待定',
  reject: '不录用',
};

export function InterviewCandidatePanel() {
  const navigate = useNavigate();
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const taskRequirement = useMarketplaceStore((s) => s.taskRequirement);
  const taskProfile = useMarketplaceStore((s) => s.taskProfile);
  const setTaskText = useMarketplaceStore((s) => s.setTaskText);
  const setJobType = useMarketplaceStore((s) => s.setJobType);

  const status = useInterviewStore((s) => s.status);
  const activeAgentId = useInterviewStore((s) => s.agentId);
  const agentName = useInterviewStore((s) => s.agentName);
  const jobType = useInterviewStore((s) => s.jobType);
  const plan = useInterviewStore((s) => s.plan);
  const turns = useInterviewStore((s) => s.turns);
  const craftTrials = useInterviewStore((s) => s.craftTrials);
  const report = useInterviewStore((s) => s.report);
  const stageScore = useInterviewStore((s) => s.stageScore);
  const startSession = useInterviewStore((s) => s.startSession);
  const finishSession = useInterviewStore((s) => s.finishSession);
  const reset = useInterviewStore((s) => s.reset);

  const [selectedId, setSelectedId] = useState<string>('');
  const [recommendation, setRecommendation] = useState<InterviewRecommendation | 'auto'>('auto');
  const [notes, setNotes] = useState<string>('');

  useEffect(() => {
    if (agents.length === 0) void fetchAgents();
  }, [agents.length, fetchAgents]);

  const emphasized = useMemo(() => boostedDims(taskProfile?.dimBoost), [taskProfile]);
  const idle = status === 'idle';

  /** 开场前展示「本场实际会用的工种」，与 handleStart 的取值口径保持一致 */
  const effectiveJob: JobType = useMemo(() => {
    if (taskProfile?.jobType) return taskProfile.jobType;
    const agent = agents.find((a) => a.id === selectedId);
    return (agent ? inferCandidateJob(agent) : null) ?? 'code';
  }, [taskProfile, agents, selectedId]);

  /** 自动预选首位候选：雇完人进来时不必再手点一次列表就能按「开始面试」。
      Agent 没有雇佣时间字段，无法定位「刚雇的那位」，故取首位。 */
  useEffect(() => {
    if (!idle || selectedId.length > 0 || agents.length === 0) return;
    setSelectedId(agents[0].id);
  }, [idle, selectedId, agents]);
  const scoring = status === 'scoring';
  const finished = status === 'finished';

  const handleStart = (): void => {
    const agent = agents.find((a) => a.id === selectedId);
    if (!agent) return;
    startSession({
      agentId: agent.id,
      agentName: agent.name,
      sessionKey: agent.mainSessionKey,
      jobType: taskProfile?.jobType ?? inferCandidateJob(agent) ?? undefined,
    });
  };

  const handleFinish = async (): Promise<void> => {
    await finishSession({
      notes: notes.trim().length > 0 ? notes.trim() : undefined,
      recommendation: recommendation === 'auto' ? undefined : recommendation,
    });
  };

  const handleReset = (): void => {
    reset();
    setRecommendation('auto');
    setNotes('');
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      {/* ★通道①：任务画像 → 考查维度。
          需求可在此直接填写（面试即「带着具体任务考人」，入口放在这里最顺），
          填完立刻重算画像并对准题序；不填也能开场，但会提示磨合成本。 */}
      <section className="glass space-y-2 rounded-2xl p-3">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Briefcase className="h-4 w-4 text-[#FFD233]" />
          这次想让他干什么
        </h3>

        {idle ? (
          <>
            <textarea
              value={taskRequirement.text}
              onChange={(e) => setTaskText(e.target.value)}
              rows={4}
              placeholder="例：我做一个面向小学生的英语打卡小程序，需要每周 3 篇图文推送，风格活泼、配图统一，交付 Markdown + 配图链接。"
              className="neu-inset w-full resize-none rounded-xl px-3 py-2 text-xs leading-relaxed text-[var(--neu-ink)] placeholder:text-[var(--neu-ink-soft)]/60 focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">工种</span>
              {(['code', 'text', 'image'] as JobType[]).map((jt) => (
                <button
                  key={jt}
                  type="button"
                  onClick={() => setJobType(jt)}
                  className={`rounded-full px-3 py-1 text-[11px] font-medium transition-all ${
                    taskRequirement.jobType === jt
                      ? 'neu-inset text-[var(--neu-ink)]'
                      : 'neu-btn text-[var(--neu-ink-soft)]'
                  }`}
                >
                  {JOB_LABELS[jt]}
                </button>
              ))}
            </div>
            {taskRequirement.text.trim().length === 0 ? (
              <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                不填也能面试，题目会换成通用问法。但写清真实需求，才能考出他合不合你的活
                —— 否则你和他可能要花更长时间磨合。
              </p>
            ) : null}
          </>
        ) : (
          <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
            {taskRequirement.text.trim().length > 0 ? taskRequirement.text : '本场未填具体需求，使用通用题序。'}
          </p>
        )}

        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">
            工种：{JOB_LABELS[effectiveJob]}
            {!taskProfile?.jobType && <span className="ml-1 opacity-70">（按候选画像推断）</span>}
          </Badge>
          {emphasized.length > 0 ? (
            emphasized.map((dim) => (
              <Badge key={dim} variant="secondary" className="gap-1">
                <Sparkles className="h-3 w-3" />
                重点考查 · {RADAR_DIM_LABELS[dim]}
              </Badge>
            ))
          ) : (
            <Badge variant="outline">六维均衡</Badge>
          )}
          {taskRequirement.tags.slice(0, 6).map((tag) => (
            <Badge key={tag} variant="outline">
              #{tag}
            </Badge>
          ))}
        </div>
      </section>

      {/* 候选选择 / 场次信息 */}
      {idle ? (
        <section className="glass flex min-h-0 flex-1 flex-col gap-2 rounded-2xl p-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <UserCheck className="h-4 w-4 text-[#FFD233]" />
              选择候选
            </h3>
            <button
              type="button"
              onClick={() => void fetchAgents()}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <RefreshCw className="h-3 w-3" />
              刷新
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
            {agents.length === 0 ? (
              <div className="space-y-2 px-1 py-4 text-center">
                <p className="text-xs text-muted-foreground">还没有可面试的员工。</p>
                <Button variant="outline" size="sm" onClick={() => navigate('/marketplace')}>
                  去人才市场雇一位
                </Button>
              </div>
            ) : (
              agents.map((agent) => {
                const active = agent.id === selectedId;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => setSelectedId(agent.id)}
                    className={`w-full rounded-md border px-2.5 py-2 text-left transition-colors ${
                      active
                        ? 'border-[#FFD233] bg-[#FFD233]/10'
                        : 'border-transparent bg-white/40 hover:bg-white/60 dark:bg-white/5'
                    }`}
                  >
                    <p className="truncate text-sm font-medium text-foreground">{agent.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {agent.persona || '未填写人设'}
                    </p>
                    {agent.mainSessionKey.length === 0 && (
                      <p className="mt-0.5 text-[10px] text-orange-500">无会话键 · 仅支持手动录入</p>
                    )}
                  </button>
                );
              })
            )}
          </div>

          <Button className="w-full" disabled={selectedId.length === 0} onClick={handleStart}>
            开始面试
          </Button>
        </section>
      ) : (
        <section className="glass space-y-2 rounded-2xl p-3">
          <h3 className="text-sm font-semibold text-foreground">本场面试</h3>
          <dl className="space-y-1 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">候选</dt>
              <dd className="truncate font-medium text-foreground">{agentName || activeAgentId}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">工种题序</dt>
              <dd className="font-medium text-foreground">
                {JOB_LABELS[jobType]} · {plan.length} 题
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">已完成</dt>
              <dd className="font-medium tabular-nums text-foreground">{turns.length} 轮</dd>
            </div>
          </dl>
        </section>
      )}

      {/* 收尾区 */}
      {!idle && !finished && (
        <section className="glass space-y-2 rounded-2xl p-3">
          <h3 className="text-sm font-semibold text-foreground">面试结论</h3>
          <select
            value={recommendation}
            onChange={(e) => setRecommendation(e.target.value as InterviewRecommendation | 'auto')}
            className="h-9 w-full rounded-md border border-white/60 bg-white/50 px-2 text-xs text-foreground shadow-sm backdrop-blur focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#FFD233] dark:bg-white/5"
          >
            {RECOMMENDATION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="面试备注（写进报告，绩效复盘可见）"
            className="w-full resize-y rounded-xl border border-white/60 bg-white/50 px-2.5 py-1.5 text-xs text-foreground shadow-sm backdrop-blur placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#FFD233] dark:bg-white/5"
          />
          <Button
            className="w-full"
            variant="default"
            // P1#7 修复：试做题-only 面试（无对话轮次、但有试做题轮次）也应可收尾，
            // 否则「纯手艺探针」链路（craft 客观分）永远卡在无法归档。
            disabled={scoring || (turns.length === 0 && craftTrials.length === 0)}
            onClick={() => void handleFinish()}
          >
            {scoring ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                生成 S2 评分卡…
              </>
            ) : (
              '结束面试并生成评分卡'
            )}
          </Button>
          {turns.length === 0 && craftTrials.length === 0 && (
            <p className="text-[11px] text-muted-foreground">至少完成一轮问答或一道试做题才能收尾。</p>
          )}
        </section>
      )}

      {/* 报告摘要 */}
      {finished && report && (
        <section className="space-y-2 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-3 backdrop-blur">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            面试报告已归档
          </h3>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant={RECOMMENDATION_TONE[report.recommendation]}>
              {RECOMMENDATION_TEXT[report.recommendation]}
            </Badge>
            <Badge variant="outline">
              S2 总分 {report.stageScoreTotal !== null ? report.stageScoreTotal.toFixed(1) : '—'}
            </Badge>
            <Badge variant="outline">
              覆盖 {Math.round(report.metrics.coverageRatio * 100)}%
            </Badge>
          </div>
          <dl className="space-y-1 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">主动澄清</dt>
              <dd className="tabular-nums text-foreground">{report.metrics.clarificationCount} 次</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">被追问</dt>
              <dd className="tabular-nums text-foreground">{report.metrics.followupCount} 次</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">平均时延</dt>
              <dd className="tabular-nums text-foreground">
                {report.metrics.avgReplyLatencyMs !== null
                  ? `${(report.metrics.avgReplyLatencyMs / 1000).toFixed(1)}s`
                  : '—'}
              </dd>
            </div>
            {stageScore && (
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">评分卡结论</dt>
                <dd className="text-foreground">{stageScore.verdict}</dd>
              </div>
            )}
          </dl>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            该报告已写入 EvaluationProfile.interviewBaseline，绩效考核（S3）将以此为对比基线。
          </p>
          <Button variant="outline" className="w-full" onClick={handleReset}>
            再面一位
          </Button>
        </section>
      )}
    </div>
  );
}
