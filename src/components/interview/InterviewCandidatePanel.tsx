/**
 * src/components/interview/InterviewCandidatePanel.tsx
 * 面试候选与场次控制台（模块 B · 设计 §4.2）。
 *
 * 三块内容：
 * 1) 任务画像卡 —— ★通道①（市场能力标签 → 面试考查维度）的可视化证据：
 *    直接展示 marketplaceStore 的需求文本 / 工种 / 被强调的六维，
 *    这些正是 selectQuestions 用来排题序的输入。
 * 2) 候选列表 —— 选人 + 开场（带上 mainSessionKey 才能真实调度作答）。
 * 3) 收尾区 —— 面试结论 + 备注 → finishSession（S2 评分卡 + 报告落库 + 基线回灌）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Briefcase, CheckCircle2, Loader2, RefreshCw, Sparkles, UserCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { boostedDims } from '@/engine/interview/questionBank';
import { RADAR_DIM_LABELS } from '@/engine/marketplace/radarSource';
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
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const taskRequirement = useMarketplaceStore((s) => s.taskRequirement);
  const taskProfile = useMarketplaceStore((s) => s.taskProfile);

  const status = useInterviewStore((s) => s.status);
  const activeAgentId = useInterviewStore((s) => s.agentId);
  const agentName = useInterviewStore((s) => s.agentName);
  const jobType = useInterviewStore((s) => s.jobType);
  const plan = useInterviewStore((s) => s.plan);
  const turns = useInterviewStore((s) => s.turns);
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
  const scoring = status === 'scoring';
  const finished = status === 'finished';

  const handleStart = (): void => {
    const agent = agents.find((a) => a.id === selectedId);
    if (!agent) return;
    startSession({
      agentId: agent.id,
      agentName: agent.name,
      sessionKey: agent.mainSessionKey,
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
      {/* ★通道①：任务画像 → 考查维度 */}
      <section className="space-y-2 rounded-lg border border-border bg-card p-3">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Briefcase className="h-4 w-4 text-[#FFD233]" />
          任务画像（来自人才市场）
        </h3>
        {taskRequirement.text.trim().length > 0 ? (
          <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
            {taskRequirement.text}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            尚未在人才市场填写需求，面试将使用通用题序。填了需求后题序会自动对准任务重心。
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">
            工种：{taskProfile?.jobType ? JOB_LABELS[taskProfile.jobType] : '不限'}
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
        <section className="flex min-h-0 flex-1 flex-col gap-2 rounded-lg border border-border bg-card p-3">
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
              <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                暂无可面试的员工，请先在人才市场雇佣。
              </p>
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
                        : 'border-transparent bg-muted/40 hover:bg-muted'
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
        <section className="space-y-2 rounded-lg border border-border bg-card p-3">
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
        <section className="space-y-2 rounded-lg border border-border bg-card p-3">
          <h3 className="text-sm font-semibold text-foreground">面试结论</h3>
          <select
            value={recommendation}
            onChange={(e) => setRecommendation(e.target.value as InterviewRecommendation | 'auto')}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
            className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button
            className="w-full"
            variant="default"
            disabled={scoring || turns.length === 0}
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
          {turns.length === 0 && (
            <p className="text-[11px] text-muted-foreground">至少完成一轮问答才能收尾。</p>
          )}
        </section>
      )}

      {/* 报告摘要 */}
      {finished && report && (
        <section className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
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
