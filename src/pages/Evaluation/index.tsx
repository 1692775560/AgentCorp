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
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Play, AlertTriangle } from 'lucide-react';

import { useEvaluationStore } from '@/stores/evaluation';
import { useAgentsStore } from '@/stores/agents';
import type { AgentSummary } from '@/types/agent';
import RadarChartView from './RadarChart';
import { RoiPanel } from './RoiPanel';
import { LifecyclePanel } from './LifecyclePanel';
import { Leaderboard } from './Leaderboard';

type PanelKey = 'radar' | 'roi' | 'lifecycle' | 'leaderboard';

const PANELS: Array<{ key: PanelKey; label: string }> = [
  { key: 'radar', label: '雷达' },
  { key: 'roi', label: 'ROI' },
  { key: 'lifecycle', label: '生命周期' },
  { key: 'leaderboard', label: '擂台' },
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
    loadAll,
    runEvaluation,
    setLifecycle,
    selectAgent,
    clearError,
  } = useEvaluationStore();

  const [panel, setPanel] = useState<PanelKey>('radar');
  const [runIdInput, setRunIdInput] = useState('');
  const [taskTitle, setTaskTitle] = useState('');

  useEffect(() => {
    void fetchAgents();
    void loadAll();
  }, [fetchAgents, loadAll]);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const handleRun = async (agent: AgentSummary) => {
    selectAgent(agent.id);
    await runEvaluation({
      runId: runIdInput.trim() || null,
      agentId: agent.id,
      agentName: agent.name,
      sessionKey: agent.mainSessionKey,
      sessionId: agent.mainSessionKey,
      taskId: '',
      task: taskTitle.trim()
        ? { title: taskTitle.trim(), description: '', weight: 1 }
        : undefined,
      persona: agent.persona,
    });
  };

  const selectedState = selectedAgentId ? (lifecycle[selectedAgentId] ?? 'ONBOARDING') : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#F7F6F2] dark:bg-background">
      <header className="flex items-center justify-between border-b border-white/40 px-6 py-4">
        <div>
          <h1 className="text-lg font-extrabold text-[#1A1C1E] dark:text-white">评估中心 · Evaluation</h1>
          <p className="text-[12px] text-gray-400">
            真实工作 + MiniCPM-o 外部裁判 · 本地数据 · 桌面端
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
          <div className="mb-3 space-y-2 rounded-2xl bg-white/70 p-3 dark:bg-white/5">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-400">
              runId（可选，来自 chat.send）
            </label>
            <input
              value={runIdInput}
              onChange={(e) => setRunIdInput(e.target.value)}
              placeholder="run_xxx（缺省仅做本地画像）"
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-[12px] outline-none focus:border-[#FFD233] dark:bg-white/10"
            />
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-400">
              任务标题（可选）
            </label>
            <input
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              placeholder="评估关联的任务"
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-[12px] outline-none focus:border-[#FFD233] dark:bg-white/10"
            />
          </div>

          <div className="space-y-2">
            {agents.length === 0 ? (
              <p className="px-2 py-4 text-sm text-gray-400">未加载到 agent。</p>
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
                      {evaluated ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-600">
                          已评估
                        </span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-400">
                          未评估
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
                      运行评估
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* 右栏：子面板 */}
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex gap-1.5 border-b border-white/40 px-6 py-3">
            {PANELS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPanel(p.key)}
                className={`rounded-full px-4 py-1.5 text-[12px] font-bold transition-all ${
                  panel === p.key
                    ? 'bg-[#FFD233] text-[#1A1C1E]'
                    : 'text-gray-400 hover:bg-white hover:text-[#1A1C1E] dark:hover:bg-white/10'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {panel === 'radar' ? (
              <div className="space-y-4">
                <RadarChartView score={radarLatest} height={320} />
                {selectedAgent ? (
                  <p className="text-[12px] text-gray-400">
                    当前选中：<span className="font-bold text-[#1A1C1E] dark:text-white">{selectedAgent.name}</span>
                    {' '}（{selectedAgent.id}）— 点击「运行评估」以刷新六维评分。
                  </p>
                ) : (
                  <p className="text-[12px] text-gray-400">从左侧选择一个 agent 查看雷达。</p>
                )}
              </div>
            ) : null}

            {panel === 'roi' ? <RoiPanel roi={roiLatest} /> : null}

            {panel === 'lifecycle' ? (
              <LifecyclePanel
                agentId={selectedAgentId}
                state={selectedState}
                busy={streaming}
                onSoftRetire={(id) => void setLifecycle(id, 'RETIRED')}
                onReactivate={(id) => void setLifecycle(id, 'ACTIVE')}
              />
            ) : null}

            {panel === 'leaderboard' ? (
              <Leaderboard
                entries={leaderboard}
                selectedAgentId={selectedAgentId}
                onSelect={(id) => selectAgent(id)}
              />
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

export default Evaluation;
