/**
 * src/components/marketplace/GithubImportBar.tsx
 * GitHub 一键导入：把开源仓库变成人才市集里的候选卡。
 *
 * 产品立场（这块 UI 的每一句文案都在守同一条线）：
 * 导入**只是让候选进场**，不代表任何能力结论。因此卡片上不显示星级、
 * 不给初始分，只显示「未评测」，并引导用户去跑 S1 初审 / S2 试做题。
 * star / license / 最近提交只作为事实展示 —— 它们是「这个项目还有人维护吗」的
 * 线索，不是「这个 agent 会不会干活」的答案。后者只能靠实测。
 *
 * 出网与 SSRF 防护全在主进程（electron/utils/github-import.ts），
 * 这里只负责递一个字符串并展示结果。
 */
import { useCallback, useEffect, useState } from 'react';
import { Github, Loader2, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import { invokeIpc } from '@/lib/api-client';

/** 与主进程 GithubCandidate 对齐（只取渲染需要的字段） */
export interface GithubImportedCandidate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  hireType: 'single';
  price: string;
  avatar: string;
  rating: null;
  hiredCount: number;
  source: 'github_import';
  jobType: 'code' | 'text' | 'image' | null;
  githubMeta: {
    owner: string;
    repo: string;
    stars: number;
    forks: number;
    openIssues: number;
    license: string;
    htmlUrl: string;
    branch: string;
    pushedAt: string;
    language: string | null;
    topics: string[];
    daysSincePush: number | null;
  };
}

interface ImportResponse {
  success: boolean;
  candidate?: GithubImportedCandidate;
  error?: string;
}

interface ListResponse {
  success: boolean;
  candidates?: GithubImportedCandidate[];
  error?: string;
}

export interface GithubImportBarProps {
  /** 导入列表变化时回调（页面据此把候选并入市集） */
  onChange: (candidates: GithubImportedCandidate[]) => void;
}

/** 维护活跃度：只陈述事实，不折算成分数 */
function activityLabel(days: number | null): { text: string; tone: string } {
  if (days === null) return { text: '提交时间未知', tone: 'text-gray-400' };
  if (days <= 30) return { text: `${days} 天前有提交`, tone: 'text-emerald-600' };
  if (days <= 180) return { text: `${days} 天前有提交`, tone: 'text-gray-500' };
  return { text: `已 ${days} 天无提交`, tone: 'text-orange-500' };
}

export function GithubImportBar({ onChange }: GithubImportBarProps) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<GithubImportedCandidate[]>([]);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await invokeIpc<ListResponse>('marketplace:listGithubImports');
      const list = res?.success ? (res.candidates ?? []) : [];
      setItems(list);
      onChange(list);
    } catch {
      // 浏览器预览态没有 IPC：静默保持空列表，不打扰用户
    }
  }, [onChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleImport = useCallback(async () => {
    const value = input.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const res = await invokeIpc<ImportResponse>('marketplace:importGithub', value);
      if (!res?.success || !res.candidate) {
        toast.error(res?.error ?? '导入失败');
        return;
      }
      setInput('');
      setExpanded(true);
      toast.success(
        `已导入 ${res.candidate.githubMeta.owner}/${res.candidate.githubMeta.repo}，去跑一道试做题看看它会不会干活`,
      );
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导入失败（主进程不可用）');
    } finally {
      setBusy(false);
    }
  }, [input, busy, refresh]);

  const handleRemove = useCallback(
    async (id: string) => {
      try {
        await invokeIpc('marketplace:removeGithubImport', id);
        await refresh();
      } catch {
        toast.error('移除失败');
      }
    },
    [refresh],
  );

  return (
    <section className="rounded-2xl border border-white/40 bg-white/70 p-4 dark:bg-white/5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm font-bold text-[#1A1C1E] dark:text-white">
          <Github size={16} />
          从 GitHub 导入开源 Agent
        </div>
        <div className="flex min-w-[280px] flex-1 items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleImport();
            }}
            placeholder="粘贴仓库地址，或直接写 owner/repo"
            aria-label="GitHub 仓库地址"
            className="min-w-0 flex-1 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm outline-none focus:border-[#FFD233] dark:border-white/10 dark:bg-white/5"
          />
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={busy || input.trim().length === 0}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-[#1A1C1E] px-5 py-2 text-sm font-bold text-white transition-all hover:bg-[#FF6B4A] disabled:opacity-40"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            导入
          </button>
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
        导入只是让候选进场，<span className="font-semibold">不代表任何能力结论</span>：
        导入卡不带星级、不给初始分，六维一律由 S1 初审与 S2 试做题实测填充。
        star 数只回答「这个项目还有人维护吗」，回答不了「它能不能替你干活」。
      </p>

      {items.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="text-[11px] font-bold text-gray-500 underline"
          >
            已导入 {items.length} 个（{expanded ? '收起' : '展开'}）
          </button>
          {expanded && (
            <ul className="mt-2 space-y-1.5">
              {items.map((item) => {
                const activity = activityLabel(item.githubMeta.daysSincePush);
                return (
                  <li
                    key={item.id}
                    className="flex items-center gap-3 rounded-xl border border-white/40 bg-white/60 px-3 py-2 text-[11px] dark:bg-white/5"
                  >
                    <span className="truncate font-bold text-[#1A1C1E] dark:text-white">
                      {item.githubMeta.owner}/{item.githubMeta.repo}
                    </span>
                    <span className="shrink-0 tabular-nums text-gray-400">
                      ★ {item.githubMeta.stars}
                    </span>
                    <span className="shrink-0 text-gray-400">{item.githubMeta.license}</span>
                    <span className={`shrink-0 ${activity.tone}`}>{activity.text}</span>
                    <span className="shrink-0 rounded-full bg-gray-400/15 px-2 py-0.5 font-bold text-gray-500">
                      未评测
                    </span>
                    {item.jobType === null && (
                      <span
                        className="flex shrink-0 items-center gap-1 text-gray-400"
                        title="无法从语言/topics 判断工种，跑题时需手动指定"
                      >
                        <TriangleAlert size={12} />
                        工种待定
                      </span>
                    )}
                    <a
                      href={item.githubMeta.htmlUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="ml-auto shrink-0 text-gray-400 underline"
                    >
                      仓库
                    </a>
                    <button
                      type="button"
                      onClick={() => void handleRemove(item.id)}
                      aria-label={`移除 ${item.name}`}
                      className="shrink-0 text-gray-400 hover:text-rose-500"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export default GithubImportBar;
