/**
 * LlmCosts Page — 成本看板
 * 采集自 runRealChat / runRealExecution 每次真实 LLM 调用的 usage，
 * 主进程 usage-log.json 持久化，本页全量拉回后前端聚合：
 * 总览卡片 + Agent 排行 + 团队汇总 + 任务明细 + 时间范围筛选（今天/近7天/全部）。
 * 图表为零依赖纯 CSS 条形图；成本按 DeepSeek 官方定价估算（见 services/llmUsage.ts）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { hostApiFetch } from '@/lib/host-api';
import { RefreshCw, Zap, DollarSign, BarChart3 } from 'lucide-react';
import {
  aggregateUsage,
  estimateRecordCostCny,
  filterUsageByRange,
  type LlmUsageRecord,
  type UsageTimeRange,
} from '@/services/llmUsage';

const RANGE_OPTIONS: Array<{ id: UsageTimeRange; label: string }> = [
  { id: 'today', label: '今天' },
  { id: '7d', label: '近 7 天' },
  { id: 'all', label: '全部' },
];

const RECENT_TASK_ROWS = 50;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCostCny(cny: number): string {
  if (cny <= 0) return '¥0';
  if (cny < 0.01) return '<¥0.01';
  return `¥${cny.toFixed(4)}`;
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return ts;
  }
}

export function LlmCosts() {
  const [records, setRecords] = useState<LlmUsageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<UsageTimeRange>('7d');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await hostApiFetch<{ entries?: LlmUsageRecord[] }>('/api/llm-usage');
      setRecords(Array.isArray(data?.entries) ? data.entries : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const filtered = useMemo(() => filterUsageByRange(records, range), [records, range]);
  const agentRows = useMemo(() => aggregateUsage(filtered, 'agent'), [filtered]);
  const teamRows = useMemo(() => aggregateUsage(filtered, 'team'), [filtered]);
  const recentRecords = useMemo(
    () => [...filtered].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, RECENT_TASK_ROWS),
    [filtered],
  );

  const totalTokens = filtered.reduce((s, r) => s + r.totalTokens, 0);
  const totalCost = filtered.reduce((s, r) => s + estimateRecordCostCny(r), 0);

  const maxAgentTokens = Math.max(...agentRows.map((r) => r.totalTokens), 1);
  const maxTeamTokens = Math.max(...teamRows.map((r) => r.totalTokens), 1);

  return (
    <div className="flex h-full flex-col bg-[#f2f2f7]">
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-[#c6c6c8] bg-white px-5">
        <h1 className="text-[15px] font-semibold text-[#000000]">成本看板</h1>
        <div className="flex items-center gap-3">
          <div className="flex overflow-hidden rounded-lg border border-[#c6c6c8]">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setRange(opt.id)}
                className={cn(
                  'px-3 py-1.5 text-[12px] transition-colors',
                  range === opt.id
                    ? 'bg-clawx-ac text-white'
                    : 'bg-white text-[#3c3c43] hover:bg-[#f2f2f7]',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => { void fetchData(); }}
            disabled={loading}
            className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] text-[#3c3c43] transition-colors hover:bg-[#f2f2f7] disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            刷新
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {error && (
          <div className="mb-4 rounded-xl bg-[#fef2f2] px-4 py-3 text-[13px] text-[#ef4444]">
            用量数据加载失败：{error}
          </div>
        )}

        {/* 总览卡片 */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { icon: <Zap className="h-4 w-4" />, label: '总 Token', value: formatTokens(totalTokens), color: '#007aff' },
            { icon: <DollarSign className="h-4 w-4" />, label: '估算成本（DeepSeek 刊例）', value: formatCostCny(totalCost), color: '#ff6a00' },
            { icon: <BarChart3 className="h-4 w-4" />, label: '调用次数', value: String(filtered.length), color: '#10b981' },
          ].map((card) => (
            <div key={card.label} className="rounded-xl bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="mb-2 flex items-center gap-2" style={{ color: card.color }}>
                {card.icon}
                <span className="text-[11px] font-semibold uppercase tracking-[0.5px] text-[#8e8e93]">{card.label}</span>
              </div>
              <p className="text-[22px] font-semibold text-[#000000]">{card.value}</p>
            </div>
          ))}
        </div>

        {filtered.length === 0 && !loading ? (
          <div className="mt-5 flex flex-col items-center gap-2 rounded-xl bg-white py-12 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <span className="text-[28px] opacity-30">💸</span>
            <span className="text-[13px] text-[#8e8e93]">该时间范围内还没有 LLM 调用用量记录</span>
            <span className="text-[12px] text-[#c6c6c8]">团队任务编排 / 会话派活的真实模型调用会自动计入</span>
          </div>
        ) : (
          <>
            {/* Agent 排行 */}
            <div className="mt-5 rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="border-b border-[#f2f2f7] px-5 py-3">
                <span className="text-[13px] font-semibold text-[#000000]">Agent 用量排行</span>
              </div>
              <div className="divide-y divide-[#f2f2f7]">
                {agentRows.map((row) => (
                  <div key={row.key} className="flex items-center gap-4 px-5 py-3">
                    <span className="w-[160px] truncate text-[13px] font-medium text-[#000000]">{row.key}</span>
                    <div className="flex-1">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#f2f2f7]">
                        <div
                          className="h-full rounded-full bg-clawx-ac"
                          style={{ width: `${Math.max(2, Math.round((row.totalTokens / maxAgentTokens) * 100))}%` }}
                        />
                      </div>
                    </div>
                    <span className="w-[70px] text-right text-[12px] text-[#3c3c43]">{formatTokens(row.totalTokens)}</span>
                    <span className="w-[80px] text-right text-[12px] text-[#ff6a00]">{formatCostCny(row.costCny)}</span>
                    <span className="w-[50px] text-right text-[11px] text-[#c6c6c8]">{row.calls} 次</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 团队汇总 */}
            <div className="mt-5 rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="border-b border-[#f2f2f7] px-5 py-3">
                <span className="text-[13px] font-semibold text-[#000000]">团队汇总</span>
              </div>
              <div className="divide-y divide-[#f2f2f7]">
                {teamRows.map((row) => (
                  <div key={row.key} className="flex items-center gap-4 px-5 py-3">
                    <span className="w-[160px] truncate text-[13px] font-medium text-[#000000]">{row.key}</span>
                    <div className="flex-1">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#f2f2f7]">
                        <div
                          className="h-full rounded-full bg-[#10b981]"
                          style={{ width: `${Math.max(2, Math.round((row.totalTokens / maxTeamTokens) * 100))}%` }}
                        />
                      </div>
                    </div>
                    <span className="w-[70px] text-right text-[12px] text-[#3c3c43]">{formatTokens(row.totalTokens)}</span>
                    <span className="w-[80px] text-right text-[12px] text-[#ff6a00]">{formatCostCny(row.costCny)}</span>
                    <span className="w-[50px] text-right text-[11px] text-[#c6c6c8]">{row.calls} 次</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 任务明细（最近 N 条） */}
            <div className="mt-5 rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="border-b border-[#f2f2f7] px-5 py-3">
                <span className="text-[13px] font-semibold text-[#000000]">
                  调用明细（最近 {recentRecords.length} 条）
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-[#f2f2f7] text-left text-[11px] font-semibold uppercase tracking-[0.5px] text-[#8e8e93]">
                      <th className="px-5 py-2.5">时间</th>
                      <th className="px-3 py-2.5">任务</th>
                      <th className="px-3 py-2.5">团队</th>
                      <th className="px-3 py-2.5">Agent</th>
                      <th className="px-3 py-2.5">模型</th>
                      <th className="px-3 py-2.5 text-right">输入</th>
                      <th className="px-3 py-2.5 text-right">输出</th>
                      <th className="px-5 py-2.5 text-right">估算成本</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#f2f2f7]">
                    {recentRecords.map((r, i) => (
                      <tr key={`${r.ts}-${i}`} className="hover:bg-[#f9f9fb]">
                        <td className="px-5 py-2.5 text-[#8e8e93]">{formatTime(r.ts)}</td>
                        <td className="max-w-[120px] truncate px-3 py-2.5 text-[#3c3c43]">{r.taskId ?? '—'}</td>
                        <td className="max-w-[100px] truncate px-3 py-2.5 text-[#3c3c43]">{r.teamId ?? '—'}</td>
                        <td className="max-w-[100px] truncate px-3 py-2.5 text-[#3c3c43]">{r.agentId ?? '—'}</td>
                        <td className="max-w-[120px] truncate px-3 py-2.5 text-[#3c3c43]">{r.model ?? '—'}</td>
                        <td className="px-3 py-2.5 text-right text-[#000000]">{formatTokens(r.promptTokens)}</td>
                        <td className="px-3 py-2.5 text-right text-[#000000]">{formatTokens(r.completionTokens)}</td>
                        <td className="px-5 py-2.5 text-right font-medium text-[#ff6a00]">{formatCostCny(estimateRecordCostCny(r))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
