/**
 * src/components/evaluation/TraceBrowserPanel.tsx
 * 历史协作 trace 浏览面板：把「可追溯」从口号变成界面上看得见的一块。
 *
 * 数据来自主进程已落盘的 A2A 委派 trace
 *（~/.openclaw/a2a-traces/<rootSessionId>.jsonl，每行一条 A2aTraceRecord），
 * 经 Host API 路由 `GET /api/traces` 与 `GET /api/traces/<id>` 读取。
 * 团队任务编排（squadOrchestration）的 A2A trace 经 POST /api/traces 同盘落盘，
 * 传入 `taskId` prop 时列表/详情按 task_id 过滤——看板任务详情
 * 「查看协作轨迹」入口即跳到本面板并带上该任务的 taskId。
 *
 * 这块面板存在的意义不是好看，而是**把「全程留痕」兑现为用户可消费的视图**：
 * - 列出历史协作 trace 文件，让用户回看每一次委派链路；
 * - 点开单条 trace 看 span 树（谁委派给谁、状态、摘要、成本/时延）；
 * - 无 trace 时明说「尚无记录」，不伪造空状态；
 * - web 预览模式（无主进程）时明说「需在桌面端使用」，不假装有数据。
 *
 * 与 JudgeHealthPanel 同口径：诚实化降级，不粉饰。
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Clock, FileText, RefreshCw } from 'lucide-react';

import { hostApiFetch } from '@/lib/host-api';
import type { A2aTraceRecord } from '@/types/evaluation';

/** 主进程 listA2aTraceFiles 返回的概览项（与 electron/services/evaluation/a2a-trace.ts 镜像）。 */
interface TraceFileSummary {
  rootSessionId: string;
  fileName: string;
  recordCount: number;
  firstSentAt: string | null;
  lastSentAt: string | null;
  sizeBytes: number;
}

interface TraceListResponse {
  traces: TraceFileSummary[];
}

interface TraceDetailResponse {
  rootSessionId: string;
  records: A2aTraceRecord[];
}

/** 把 ISO 时间缩成「HH:mm:ss」短显示，解析失败原样返回。 */
function shortTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

/** 把 ISO 时间缩成「MM-DD HH:mm」显示。 */
function medTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return iso;
  }
}

/** 状态 → 颜色与文案（与 traceModel a2aStateToTraceStatus 对齐）。 */
function stateBadge(state: A2aTraceRecord['state']): { text: string; tone: string } {
  switch (state) {
    case 'completed':
      return { text: '完成', tone: 'text-emerald-600' };
    case 'failed':
      return { text: '失败', tone: 'text-rose-500' };
    case 'canceled':
      return { text: '已取消', tone: 'text-gray-500' };
    case 'working':
      return { text: '进行中', tone: 'text-sky-600' };
    case 'input-required':
      return { text: '待审批', tone: 'text-amber-600' };
    case 'submitted':
      return { text: '已提交', tone: 'text-sky-600' };
    default:
      return { text: String(state), tone: 'text-gray-500' };
  }
}

/** 组装 trace API 路径：带 taskId 时附过滤参数（团队任务「协作轨迹」入口）。 */
export function traceListPath(taskId?: string): string {
  return taskId ? `/api/traces?taskId=${encodeURIComponent(taskId)}` : '/api/traces';
}

/** 单文件详情路径（同样支持 taskId 过滤 records）。 */
export function traceDetailPath(rootSessionId: string, taskId?: string): string {
  const base = `/api/traces/${encodeURIComponent(rootSessionId)}`;
  return taskId ? `${base}?taskId=${encodeURIComponent(taskId)}` : base;
}

export function TraceBrowserPanel({ taskId }: { taskId?: string }) {
  const [files, setFiles] = useState<TraceFileSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [records, setRecords] = useState<A2aTraceRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnreachable(false);
    try {
      const res = await hostApiFetch<TraceListResponse>(traceListPath(taskId));
      setFiles(res.traces ?? []);
    } catch (err) {
      const msg = String(err);
      // web 预览模式：127.0.0.1:3210 不可达 / fetch failed
      if (/failed to fetch|networkerror|load failed|127\.0\.0\.1/i.test(msg)) {
        setUnreachable(true);
      } else {
        setError(msg);
      }
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleOpen = useCallback(
    async (rootSessionId: string) => {
      if (openId === rootSessionId) {
        setOpenId(null);
        setRecords([]);
        return;
      }
      setOpenId(rootSessionId);
      setRecordsLoading(true);
      setRecords([]);
      try {
        const res = await hostApiFetch<TraceDetailResponse>(
          traceDetailPath(rootSessionId, taskId),
        );
        setRecords(res.records ?? []);
      } catch (err) {
        setError(String(err));
        setRecords([]);
      } finally {
        setRecordsLoading(false);
      }
    },
    [openId, taskId],
  );

  return (
    <section className="rounded-2xl border border-dashed border-gray-300 p-5">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-gray-500" />
          <h3 className="text-sm font-bold text-gray-700">协作 trace 回放</h3>
          <span className="text-xs text-gray-400">每一次委派都留痕</span>
          {taskId ? (
            <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[10px] text-indigo-500">
              任务 {taskId}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </header>

      {unreachable ? (
        <p className="mt-3 text-xs text-gray-400">
          主进程不可达：trace 浏览需在桌面端使用（web 预览模式下主机 API 不存在）。
        </p>
      ) : error ? (
        <p className="mt-3 text-xs text-rose-500">读取失败：{error}</p>
      ) : loading ? (
        <p className="mt-3 text-xs text-gray-400">加载中…</p>
      ) : files.length === 0 ? (
        <p className="mt-3 text-xs text-gray-400">
          {taskId
            ? '该任务尚无协作 trace 记录。团队任务完成一轮协作（或落盘通道不可用）前，这里不会有内容。'
            : '尚无协作 trace 记录。委派任务并完成一轮协作后，这里会出现可回放的历史。'}
        </p>
      ) : (
        <ul className="mt-3 space-y-1">
          {files.map((f) => {
            const isOpen = openId === f.rootSessionId;
            return (
              <li key={f.fileName} className="rounded-lg border border-gray-200">
                <button
                  type="button"
                  onClick={() => void toggleOpen(f.rootSessionId)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
                >
                  {isOpen ? (
                    <ChevronDown className="h-3 w-3 text-gray-400" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-gray-400" />
                  )}
                  <FileText className="h-3 w-3 text-gray-400" />
                  <span className="font-mono text-xs text-gray-600">
                    {f.rootSessionId}
                  </span>
                  <span className="text-xs text-gray-400">
                    · {f.recordCount} 条 · 最近 {medTime(f.lastSentAt)}
                  </span>
                </button>

                {isOpen ? (
                  <div className="border-t border-gray-100 px-3 py-2">
                    {recordsLoading ? (
                      <p className="text-xs text-gray-400">加载 trace…</p>
                    ) : records.length === 0 ? (
                      <p className="text-xs text-gray-400">该 trace 无记录（文件可能为空或损坏）。</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {records.map((r) => {
                          const badge = stateBadge(r.state);
                          return (
                            <li
                              key={r.trace_id}
                              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs"
                            >
                              <span className={`font-semibold ${badge.tone}`}>
                                {badge.text}
                              </span>
                              <span className="text-gray-400">
                                {shortTime(r.sent_at)}
                              </span>
                              <span className="font-mono text-gray-600">
                                {r.delegator} → {r.delegatee}
                              </span>
                              <span className="text-gray-700">{r.summary}</span>
                              {r.kind ? (
                                <span className="text-gray-400">[{r.kind}]</span>
                              ) : null}
                              {typeof r.cost_usd === 'number' && r.cost_usd !== null ? (
                                <span className="text-gray-400">
                                  ${r.cost_usd.toFixed(4)}
                                </span>
                              ) : null}
                              {typeof r.tokens === 'number' && r.tokens !== null ? (
                                <span className="text-gray-400">{r.tokens} tok</span>
                              ) : null}
                              {typeof r.latency_ms === 'number' && r.latency_ms !== null ? (
                                <span className="text-gray-400">{r.latency_ms} ms</span>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default TraceBrowserPanel;
