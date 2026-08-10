/**
 * src/pages/Evaluation/index.tsx
 * 评估中心主页面（T04 挂载点）。
 *
 * 布局：
 * - 左栏：agent 列表（含评估状态）+ 触发评估 / 软退休 等动作。
 * - 右栏：六维雷达、ROI、生命周期治理、擂台排名四个子面板。
 *
 * 数据流（评估契约）：用户选定 agent（+ 可选 task / runId）→ 本地编排
 * store.runEvaluation（真实 KPI/ROI + MiniCPM-o 裁判）→ 落库 EvaluationProfile
 * 并将 runId↔task 关联写入（T06）。捕获 runId 的入口即在本页（来自
 * gateway.rpc('chat.send') 返回值，可由调用方注入）。
 *
 * i18n：用户可见文案走 common:evaluation.*（含面板标签 / 表单 / 空态）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Play, AlertTriangle, Volume2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useEvaluationStore } from '@/stores/evaluation';
import { useAgentsStore } from '@/stores/agents';
import { getActiveBossProfile, listBossProfiles } from '@/stores/bossProfile';
import { listAgentSessions, type AgentSessionOption } from '@/services/evaluationData';
import { speech } from '@/services/speech';
import { useConvergenceStore } from '@/stores/convergenceStore';
import type { AgentSummary } from '@/types/agent';
import RadarChartView from './RadarChart';
import { RoiPanel } from './RoiPanel';
import { LifecyclePanel } from './LifecyclePanel';
import { Leaderboard } from './Leaderboard';
import { DualTrackScoreCard } from '@/components/evaluation/DualTrackScoreCard';
import { DualLeaderboard } from '@/components/evaluation/DualLeaderboard';
import { BossFavoriteLeaderboard } from '@/components/marketplace/BossFavoriteLeaderboard';
import { BossProfileSelector } from '@/components/persona/BossProfileSelector';
import { SuiteView } from '@/components/evaluation/SuiteView';
import { PreferenceInsightPanel } from '@/components/evaluation/PreferenceInsightPanel';
import { ConvergenceTrajectoryWidget } from '@/components/evaluation/ConvergenceTrajectoryWidget';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import { RADAR_DIM_LABELS } from '@/engine/marketplace/radarSource';

/**
 * 页签从 9 个收拢成 4 组：原先「雷达/讲解/ROI/生命周期/擂台/双轨评分/双榜/收敛/心智模型」
 * 平铺，用户无从判断该看哪个。现在按「看结果 → 看排名 → 看偏好 → 管人员」的
 * 使用场景归组，同组内容纵向叠放。
 */
type PanelKey = 'result' | 'ranking' | 'preference' | 'manage';

const PANELS: Array<{ key: PanelKey; label: string; hint: string }> = [
  { key: 'result', label: '这位员工怎么样', hint: '六维画像、投入产出、模型讲解' },
  { key: 'ranking', label: '谁更合适', hint: '客观榜与主观榜并排对比' },
  { key: 'preference', label: '我的偏好', hint: '你的打分习惯与收敛过程' },
  { key: 'manage', label: '人员状态', hint: '上岗、维护与软退休' },
];

function LifecycleDot({ state }: { state: string }) {
  const color =
    state === 'RETIRED'
      ? 'bg-rose-500'
      : state === 'ACTIVE'
        ? 'bg-emerald-500'
        : state === 'TRAINING'
          ? 'bg-sky-500'
          : state === 'MAINTENANCE'
            ? 'bg-violet-500'
            : 'bg-amber-500';
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

export function Evaluation() {
  const { t } = useTranslation('common');
  const agents = (useAgentsStore((s) => s.agents) ?? []) as AgentSummary[];
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  const {
    profiles,
    lifecycle,
    radarLatest,
    roiLatest,
    leaderboard,
    selectedAgentId,
    streaming,
    error,
    narrationText,
    voiceEnabled,
    passKResult,
    passKRunning,
    runPassK,
    loadAll,
    runEvaluation,
    setLifecycle,
    selectAgent,
    clearError,
    toggleVoice,
  } = useEvaluationStore();

  const [panel, setPanel] = useState<PanelKey>('result');
  const [runIdInput, setRunIdInput] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [sessionOptions, setSessionOptions] = useState<AgentSessionOption[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const narrationRef = useRef<HTMLDivElement>(null);

  // 讲解文本流式追加时自动滚到底部
  useEffect(() => {
    const el = narrationRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [narrationText]);

  useEffect(() => {
    void fetchAgents();
    void loadAll();
  }, [fetchAgents, loadAll]);

  // 离开评估页时停止播报
  useEffect(() => {
    return () => {
      speech.cancel();
    };
  }, []);

  // 选中 agent 变化时加载其真实会话列表，并重置会话选择
  useEffect(() => {
    setSelectedSessionId('');
    setSessionOptions([]);
    if (!selectedAgentId) return;
    let cancelled = false;
    listAgentSessions(selectedAgentId)
      .then((options) => {
        if (!cancelled) setSessionOptions(options);
      })
      .catch(() => {
        if (!cancelled) setSessionOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAgentId]);

  // 收敛面板数据（T18 widget 接入：按当前 trace/score 展示，无则空态）
  const convergenceTrace = useConvergenceStore((s) => s.trace);
  const convergenceScore = useConvergenceStore((s) => s.score);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  /** 当前选中 agent 的评估档案（含面试基线 interviewBaseline） */
  const selectedProfile = selectedAgentId ? (profiles[selectedAgentId] ?? null) : null;

  const handleRun = async (agent: AgentSummary) => {
    // 会话下拉框属于当前选中的 agent；对未选中的 agent 点「运行评估」时
    // selectAgent 会异步重置选择，这里必须忽略残留的跨 agent 会话，
    // 否则会把 A 的 sessionId 写进 B 的评估与 runlink。
    const session =
      agent.id === selectedAgentId
        ? (sessionOptions.find((s) => s.sessionId === selectedSessionId) ?? null)
        : null;
    selectAgent(agent.id);
    await runEvaluation({
      runId: runIdInput.trim() || null,
      agentId: agent.id,
      agentName: agent.name,
      sessionKey: session?.sessionKey ?? '',
      sessionId: session?.sessionId ?? '',
      taskId: '',
      task: taskTitle.trim()
        ? { title: taskTitle.trim(), description: '', weight: 1 }
        : undefined,
      persona: agent.persona,
      // A · 老板原型：把当前激活的用户个性化画像带入评估（区别于 agent 自身 persona）
      bossProfile: getActiveBossProfile(),
    });
  };

  const selectedState = selectedAgentId ? (lifecycle[selectedAgentId] ?? 'ONBOARDING') : null;

  return (
    <div className="tech-bg flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-white/40 px-6 py-4">
        <div>
          <h1 className="text-lg font-extrabold text-[#1A1C1E] dark:text-white">
            {t('evaluation.title', '评估中心 · Evaluation')}
          </h1>
          <p className="text-[12px] text-gray-400">
            {t('evaluation.subtitle', '真实工作 + MiniCPM-o 外部裁判 · 本地数据 · 桌面端')}
          </p>
        </div>
        {error ? (
          <button
            type="button"
            onClick={clearError}
            className="flex items-center gap-1.5 rounded-full bg-rose-100 px-3 py-1.5 text-[12px] font-bold text-rose-600"
          >
            <AlertTriangle className="h-3.5 w-3.5" /> {error}
          </button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左栏：agent 列表 */}
        <aside className="w-[300px] shrink-0 overflow-y-auto border-r border-white/40 p-4">
          {/* A · 老板原型选择器：决定「与谁协作」的评估视角（个性化基线） */}
          <div className="mb-3">
            <BossProfileSelector />
          </div>

          <div className="mb-3 space-y-2 rounded-2xl bg-white/70 p-3 dark:bg-white/5">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-400">
              {t('evaluation.sessionLabel', '评估会话（真实运行记录）')}
            </label>
            <select
              value={selectedSessionId}
              onChange={(e) => setSelectedSessionId(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-[12px] outline-none focus:border-[#FFD233] dark:bg-white/10"
            >
              <option value="">{t('evaluation.sessionLocalOnly', '仅本地画像（不关联会话）')}</option>
              {sessionOptions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.sessionId.slice(0, 8)}…{s.updatedAt ? ` · ${s.updatedAt.slice(0, 10)}` : ''}
                </option>
              ))}
            </select>
            {selectedAgentId && sessionOptions.length === 0 ? (
              <p className="text-[11px] text-gray-400">
                {t('evaluation.noSessions', '该 agent 暂无运行记录。')}
              </p>
            ) : null}
            {/* runId / 任务标题是排查用的技术字段，默认折叠，避免和主流程抢注意力 */}
            <details className="group">
              <summary className="cursor-pointer list-none text-[11px] font-bold text-gray-400 hover:text-[#1A1C1E] dark:hover:text-white">
                {t('evaluation.advancedToggle', '高级选项（可选）')}
              </summary>
              <div className="mt-2 space-y-2">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-400">
                  {t('evaluation.runIdLabel', 'runId（可选，来自 chat.send）')}
                </label>
                <input
                  value={runIdInput}
                  onChange={(e) => setRunIdInput(e.target.value)}
                  placeholder={t('evaluation.runIdPlaceholder', 'run_xxx（缺省不写 runlink）')}
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-[12px] outline-none focus:border-[#FFD233] dark:bg-white/10"
                />
                <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-400">
                  {t('evaluation.taskTitleLabel', '任务标题（可选）')}
                </label>
                <input
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  placeholder={t('evaluation.taskTitlePlaceholder', '评估关联的任务')}
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-[12px] outline-none focus:border-[#FFD233] dark:bg-white/10"
                />
              </div>
            </details>
          </div>

          <div className="space-y-2">
            {agents.length === 0 ? (
              <p className="px-2 py-4 text-sm text-gray-400">
                {t('evaluation.noAgents', '还没有员工可评估，先去人才市场雇一位。')}
              </p>
            ) : (
              agents.map((agent) => {
                const st = lifecycle[agent.id] ?? 'ONBOARDING';
                const evaluated = Boolean(profiles[agent.id]);
                const active = agent.id === selectedAgentId;
                return (
                  <div
                    key={agent.id}
                    className={`rounded-2xl border p-3 transition-all ${
                      active
                        ? 'border-[#FFD233] bg-[#FFD233]/10'
                        : 'border-white/40 bg-white/70 hover:bg-white dark:bg-white/5'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => selectAgent(agent.id)}
                      className="flex w-full items-center gap-2 text-left"
                    >
                      <LifecycleDot state={st} />
                      <span className="flex-1 truncate text-[13px] font-bold text-[#1A1C1E] dark:text-white">
                        {agent.name}
                      </span>
                      {profiles[agent.id]?.interviewBaseline ? (
                        <span
                          className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-600"
                          title={t('evaluation.baselineTitle', '已有面试基线（S2 → S3 贯通）')}
                        >
                          {t('evaluation.baselineBadge', '基线')}
                        </span>
                      ) : null}
                      {evaluated ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-600">
                          {t('evaluation.evaluated', '已评估')}
                        </span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-400">
                          {t('evaluation.notEvaluated', '未评估')}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={streaming}
                      onClick={() => void handleRun(agent)}
                      className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-full bg-[#1A1C1E] px-3 py-2 text-[12px] font-bold text-white shadow-sm transition-all hover:bg-[#FF6B4A] disabled:opacity-50 dark:bg-white dark:text-[#1A1C1E]"
                    >
                      {streaming && selectedAgentId === agent.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                      {t('evaluation.runEvaluation', '运行评估')}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* 右栏：子面板 */}
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-white/40 px-6 py-3">
            <div className="flex flex-wrap gap-1.5">
              {PANELS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPanel(p.key)}
                  title={p.hint}
                  className={`rounded-full px-4 py-1.5 text-[12px] font-bold transition-all ${
                    panel === p.key
                      ? 'bg-[#FFD233] text-[#1A1C1E]'
                      : 'text-gray-400 hover:bg-white hover:text-[#1A1C1E] dark:hover:bg-white/10'
                  }`}
                >
                  {t(`evaluation.panels.${p.key}`, p.label)}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-gray-400">
              {PANELS.find((p) => p.key === panel)?.hint}
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {panel === 'result' ? (
              <div className="space-y-6">
                {/* 面试基线叠加（interviewBaseline.radar，无则不传，baseline prop 已存在） */}
                <RadarChartView
                  score={radarLatest}
                  baseline={selectedProfile?.interviewBaseline?.radar ?? null}
                  height={320}
                />
                {selectedProfile?.interviewBaseline?.radar ? (
                  <p className="text-[12px] text-gray-400">
                    {t('evaluation.radarBaselineHint', '灰色多边形 = 面试基线（S2），黄色 = 当前绩效（S3）。')}
                  </p>
                ) : null}
                {selectedAgent ? (
                  <p className="text-[12px] text-gray-400">
                    {t('evaluation.radarSelectedPre', '当前选中：')}
                    <span className="font-bold text-[#1A1C1E] dark:text-white">{selectedAgent.name}</span>
                    {t('evaluation.radarSelectedPost', {
                      id: selectedAgent.id,
                      defaultValue: '（{{id}}）— 点击「运行评估」以刷新六维评分。',
                    })}
                  </p>
                ) : (
                  <p className="text-[12px] text-gray-400">
                    {t('evaluation.radarSelectHint', '从左侧选择一位员工，再点「运行评估」查看结果。')}
                  </p>
                )}

                {/* C · 基准套件：维度×原型矩阵 + 个性化增量（人格化评估的核心视图） */}
                <SuiteView
                  agentId={selectedAgentId}
                  radarByPersona={selectedProfile?.radarByPersona}
                  profiles={listBossProfiles()}
                />

                {/* 双轨评分卡（客观遥测 + 主观打分 + 0.7/0.3 加权 total） */}
                <DualTrackScoreCard agentId={selectedAgentId} />

                {/* 可靠性 pass^k（跨家族 ensemble + 重复采样；核心差异化指标） */}
                <div className="space-y-3 rounded-2xl bg-white/70 p-4 dark:bg-white/5">
                  <div className="flex items-center justify-between">
                    <p className="text-[12px] font-bold text-[#1A1C1E] dark:text-white">
                      可靠性 pass^k
                    </p>
                    <button
                      type="button"
                      disabled={passKRunning || !selectedAgentId}
                      onClick={() => selectedAgentId && void runPassK(selectedAgentId, 3)}
                      className="rounded-full bg-[#1A1C1E] px-3 py-1.5 text-[11px] font-bold text-white transition-all hover:bg-[#FF6B4A] disabled:opacity-50 dark:bg-white dark:text-[#1A1C1E]"
                    >
                      {passKRunning ? '测算中…' : '测可靠性 (pass^k)'}
                    </button>
                  </div>
                  {passKResult ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                            passKResult.allPass
                              ? 'bg-emerald-100 text-emerald-600'
                              : 'bg-amber-100 text-amber-600'
                          }`}
                        >
                          {passKResult.allPass ? '可靠（k 次全过）' : '不稳定（未全过）'}
                        </span>
                        <span className="text-[11px] text-gray-400">
                          单轮全维通过率 {Math.round(passKResult.passRate * 100)}% · k=
                          {passKResult.k}
                        </span>
                      </div>
                      <div className="space-y-1">
                        {RADAR_DIMS.map((dim) => {
                          const rate = passKResult.dimPassRate[dim] ?? 0;
                          return (
                            <div key={dim} className="flex items-center gap-2">
                              <span className="w-10 text-[10px] text-gray-400">
                                {RADAR_DIM_LABELS[dim]}
                              </span>
                              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-white/10">
                                <div
                                  className="h-full rounded-full bg-[#FFD233]"
                                  style={{ width: `${Math.round(rate * 100)}%` }}
                                />
                              </div>
                              <span className="w-9 text-right text-[10px] text-gray-400">
                                {Math.round(rate * 100)}%
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] text-gray-400">
                      对同一条对话重复裁判 k=3 次，仅当每次都全维达标才算「可靠」。需先运行一次评估，再点此测算（依赖联网裁判服务）。
                    </p>
                  )}
                </div>

                {/* 投入产出 */}
                <RoiPanel roi={roiLatest} />

                {/* 模型讲解 */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[12px] text-gray-400">
                      {t('evaluation.narrationStatus', {
                        state: voiceEnabled
                          ? t('evaluation.voiceStateOn', '语音播报开')
                          : t('evaluation.voiceStateOff', '语音播报关'),
                        defaultValue: '模型讲解（{{state}}）',
                      })}
                    </p>
                    <button
                      type="button"
                      onClick={toggleVoice}
                      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-bold transition-all ${
                        voiceEnabled
                          ? 'bg-[#FFD233] text-[#1A1C1E]'
                          : 'bg-gray-100 text-gray-400 dark:bg-white/10'
                      }`}
                    >
                      {voiceEnabled ? (
                        <Volume2 className="h-3.5 w-3.5" />
                      ) : (
                        <VolumeX className="h-3.5 w-3.5" />
                      )}
                      {voiceEnabled
                        ? t('evaluation.voiceOn', '语音开')
                        : t('evaluation.voiceOff', '语音关')}
                    </button>
                  </div>
                  <div
                    ref={narrationRef}
                    className="h-[360px] overflow-y-auto rounded-2xl bg-white/70 p-4 text-[13px] leading-6 text-[#1A1C1E] dark:bg-white/5 dark:text-white"
                  >
                    {narrationText ? (
                      narrationText
                    ) : (
                      <span className="text-gray-400">
                        {t('evaluation.narrationEmpty', '点击「运行评估」后，模型讲解将在此逐句滚动并语音播报。')}
                      </span>
                    )}
                    {streaming ? (
                      <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin text-gray-400" />
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {/* 双榜：客观榜 + 可拖拽主观榜（拖拽即偏好回灌）+ 擂台名次 */}
            {/* 最受 boss 青睐榜从人才市集迁入：它是测评结果而非选人筛选条件 */}
            {panel === 'ranking' ? (
              <div className="space-y-6">
                <DualLeaderboard
                  stage="performance"
                  jobType={selectedProfile?.jobType ?? 'all'}
                />
                <Leaderboard
                  entries={leaderboard}
                  selectedAgentId={selectedAgentId}
                  onSelect={(id) => selectAgent(id)}
                />
                <BossFavoriteLeaderboard />
              </div>
            ) : null}

            {/* 用户心智模型（userWeight vs 基准 + dimLift）+ 收敛轨迹 */}
            {panel === 'preference' ? (
              <div className="space-y-6">
                <PreferenceInsightPanel />
                <ConvergenceTrajectoryWidget
                  trace={convergenceTrace}
                  score={convergenceScore}
                />
              </div>
            ) : null}

            {panel === 'manage' ? (
              <LifecyclePanel
                agentId={selectedAgentId}
                state={selectedState}
                busy={streaming}
                onSoftRetire={(id) => void setLifecycle(id, 'RETIRED')}
                onReactivate={(id) => void setLifecycle(id, 'ACTIVE')}
              />
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

export default Evaluation;
