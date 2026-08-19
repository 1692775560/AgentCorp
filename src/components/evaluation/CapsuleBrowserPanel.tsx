/**
 * src/components/evaluation/CapsuleBrowserPanel.tsx
 * 经验胶囊浏览面板：把「真实交付回流」沉淀的胶囊变成用户可回看的视图。
 *
 * 数据来自主进程已落盘的经验胶囊
 *（~/.openclaw/capsules/capsules.jsonl，每行一颗 ExperienceCapsule），
 * 经 Host API 路由 `GET /api/capsules` 读取。
 *
 * 这块面板存在的意义：让用户看见「系统记住了我的哪些协作」——
 * 哪个 Agent 干了什么活、真实交付如何、是否通过验收、六维快照是什么。
 * 这是「人的能力增量」北极星的可见锚点：前后胶囊对比即能力成长。
 *
 * 与 TraceBrowserPanel 同口径：诚实化降级，不伪造空状态。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Package,
  RefreshCw,
  ThumbsUp,
  ThumbsDown,
} from 'lucide-react';

import { hostApiFetch } from '@/lib/host-api';
import type { ExperienceCapsule } from '@/types/capsule';
import type { RadarScore } from '@/types/evaluation';

interface CapsuleListResponse {
  capsules: ExperienceCapsule[];
}

/** 把 ISO 时间缩成「MM-DD HH:mm」短显示。 */
function medTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return String(iso);
  }
}

/** 六维快照的简短展示。 */
function radarDigest(radar: RadarScore | null): string {
  if (!radar) return '无六维快照';
  const dims: Array<[string, number]> = [
    ['任', radar.task],
    ['质', radar.quality],
    ['达', radar.comm],
    ['创', radar.creativity],
    ['稳', radar.reliability],
    ['价', radar.cost],
  ];
  return dims.map(([d, v]) => `${d}${v.toFixed(1)}`).join(' ');
}

/** 人的判断三态徽章。 */
function judgmentBadge(j?: string | null): { text: string; tone: string; Icon: typeof ThumbsUp } {
  if (j === 'approved') return { text: '通过', tone: 'text-emerald-600', Icon: ThumbsUp };
  if (j === 'rejected') return { text: '未过', tone: 'text-rose-500', Icon: ThumbsDown };
  return { text: '未判定', tone: 'text-gray-400', Icon: Package };
}

export function CapsuleBrowserPanel() {
  const [capsules, setCapsules] = useState<ExperienceCapsule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnreachable(false);
    try {
      const res = await hostApiFetch<CapsuleListResponse>('/api/capsules');
      setCapsules(res.capsules ?? []);
    } catch (err) {
      const msg = String(err);
      if (/failed to fetch|networkerror|load failed|127\.0\.0\.1/i.test(msg)) {
        setUnreachable(true);
      } else {
        setError(msg);
      }
      setCapsules([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(
    (id: string) => {
      setOpenId((cur) => (cur === id ? null : id));
    },
    [],
  );

  return (
    <section className="rounded-2xl border border-dashed border-gray-300 p-5">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Package className="h-5 w-5 text-gray-500" />
          <h3 className="text-sm font-bold text-gray-700">经验胶囊</h3>
          <span className="text-xs text-gray-400">
            真实交付回流·{capsules.length} 颗
          </span>
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
          主进程不可达：经验胶囊浏览需在桌面端使用（web 预览模式下主机 API 不存在）。
        </p>
      ) : error ? (
        <p className="mt-3 text-xs text-rose-500">读取失败：{error}</p>
      ) : loading ? (
        <p className="mt-3 text-xs text-gray-400">加载中…</p>
      ) : capsules.length === 0 ? (
        <p className="mt-3 text-xs text-gray-400">
          尚无经验胶囊。完成一次真实任务交付并回流评测后，这里会出现可回看的协作记录——
          胶囊是「真实交付反哺选人」与「人的能力增量」的基础。
        </p>
      ) : (
        <ul className="mt-3 space-y-1">
          {capsules.map((c) => {
            const isOpen = openId === c.capsuleId;
            const jb = judgmentBadge(c.humanJudgment);
            const Icon = jb.Icon;
            return (
              <li key={c.capsuleId} className="rounded-lg border border-gray-200">
                <button
                  type="button"
                  onClick={() => toggle(c.capsuleId)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
                >
                  {isOpen ? (
                    <ChevronDown className="h-3 w-3 text-gray-400" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-gray-400" />
                  )}
                  <Icon className={`h-3 w-3 ${jb.tone}`} />
                  <span className="text-xs text-gray-700">{c.taskTitle}</span>
                  <span className="text-xs text-gray-400">
                    · {c.agentName} · {medTime(c.createdAt)}
                  </span>
                  {c.jobType ? (
                    <span className="text-xs text-gray-400">[{c.jobType}]</span>
                  ) : null}
                </button>

                {isOpen ? (
                  <div className="border-t border-gray-100 px-3 py-2 text-xs">
                    <div className="mb-1 flex flex-wrap gap-x-3 gap-y-1">
                      <span className="text-gray-500">Agent：{c.agentName}</span>
                      <span className={`font-semibold ${jb.tone}`}>
                        {jb.text}
                      </span>
                      {typeof c.reworkRounds === 'number' && c.reworkRounds > 0 ? (
                        <span className="text-gray-400">
                          返工 {c.reworkRounds} 轮
                        </span>
                      ) : null}
                      {typeof c.userFit === 'number' ? (
                        <span className="text-gray-400">
                          契合 {c.userFit.toFixed(0)}
                        </span>
                      ) : null}
                    </div>
                    <div className="mb-1 text-gray-500">
                      六维：{radarDigest(c.radar)}
                    </div>
                    {c.taskDescriptionDigest ? (
                      <div className="mb-1 text-gray-500">
                        任务：{c.taskDescriptionDigest}
                      </div>
                    ) : null}
                    {c.outputDigest ? (
                      <div className="mb-1 text-gray-500">
                        交付摘要：{c.outputDigest}
                        {c.outputLength > c.outputDigest.length ? '…' : ''}
                      </div>
                    ) : null}
                    <div className="text-gray-400">
                      胶囊 ID：{c.capsuleId}
                    </div>
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

export default CapsuleBrowserPanel;
