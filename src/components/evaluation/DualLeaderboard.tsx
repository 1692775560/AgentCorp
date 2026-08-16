/**
 * src/components/evaluation/DualLeaderboard.tsx
 * 双榜组件：客观榜与主观榜并列展示。
 *
 * - 客观榜：按 objectiveScore 降序（原逻辑，不污染公平排名）。
 * - 主观榜：默认序=客观序预排；用户可用 @dnd-kit 拖拽重排（仅偏好 overlay）。
 * - 自动高亮 divergences（客观序 vs 拖拽序发散）。
 * - 说明：「拖拽仅为偏好 overlay，不改客观结论」。
 *
 * 每次拖拽除调用 scoringStore.onReorder（偏好回灌）
 * 外，额外调用 convergenceStore.setAnchor(trace, topCandidateId,
 * "dual_leaderboard_drag")——把拖拽置顶候选回填为 HumanAnchor。若当前无活跃
 * convergence trace，则静默 noop（不报错），与 explicit_pin 源互斥合并。
 *
 * 样式实现：Tailwind，无 @mui 依赖。
 * - Paper            → section.rounded-2xl border bg-white/60（对齐 Leaderboard.tsx 风格）；
 * - List/ListItem    → ul/li + flex 行布局；
 * - Chip(warning Δ)  → span.rounded-full bg-amber-100 text-amber-700；
 * - Divider          → ui/separator（Radix）。
 * @dnd-kit 拖拽逻辑、onReorder（偏好回灌）与 setAnchor（锚点回填）保持不变；
 * props 契约不变（stage / jobType），调用方零适配。
 *
 * i18n：用户可见文案走 common:evaluation.dual.*。
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';

import { Separator } from '@/components/ui/separator';
import { useScoringStore } from '@/stores/scoringStore';
import { useConvergenceStore } from '@/stores/convergenceStore';
import type {
  SubjectiveBoardEntry,
  StageKey,
  JobType,
} from '@/types/evaluation';

interface Props {
  stage: StageKey;
  jobType: JobType | 'all';
}

/** 主观榜可拖拽行（发散项琥珀色高亮 + Δ 徽章） */
function SortableRow({
  entry,
  divergent,
  rank,
}: {
  entry: SubjectiveBoardEntry;
  divergent: boolean;
  rank: number;
}) {
  const { t } = useTranslation('common');
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: entry.agentId,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`flex cursor-grab items-center justify-between rounded-xl border px-3 py-2 transition-colors active:cursor-grabbing ${
        divergent
          ? 'border-amber-400/70 bg-amber-400/10'
          : 'border-transparent bg-white/70 hover:bg-white dark:bg-white/5 dark:hover:bg-white/10'
      }`}
    >
      <div className="min-w-0">
        <p className="truncate text-[13px] font-bold text-[#1A1C1E] dark:text-white">
          #{rank} {entry.name || entry.agentId}
        </p>
        <p className="text-[11px] text-gray-400">
          {t('evaluation.dual.subScoreLine', {
            score: entry.subjectiveScore.toFixed(1),
            rank: entry.objectiveRank,
            defaultValue: '主观分 {{score}} · 客观序 #{{rank}}',
          })}
        </p>
      </div>
      {divergent ? (
        <span className="ml-2 shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
          Δ{entry.dragRank - entry.objectiveRank}
        </span>
      ) : null}
    </li>
  );
}

/** 榜单卡片外壳（客观/主观两栏共用，对齐 rounded-2xl border bg-white/60 风格） */
function BoardCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-[280px] flex-1 rounded-2xl border border-white/40 bg-white/60 p-3 dark:bg-white/5">
      <h3 className="mb-2 px-1 text-[12px] font-bold text-[#1A1C1E] dark:text-white">{title}</h3>
      {children}
    </section>
  );
}

const TIER_CLS: Record<string, string> = {
  MVP: 'bg-[#FFD233] text-[#1A1C1E]',
  NORMAL: 'bg-white/60 text-gray-500 dark:bg-white/10',
  BOTTOM: 'bg-rose-500 text-white',
};

export function DualLeaderboard({ stage, jobType }: Props) {
  const { t } = useTranslation('common');
  const dualLeaderboard = useScoringStore((s) => s.dualLeaderboard);
  const loadDualLeaderboard = useScoringStore((s) => s.loadDualLeaderboard);
  const onReorder = useScoringStore((s) => s.onReorder);
  const setAnchor = useConvergenceStore((s) => s.setAnchor);

  // 主观榜本地可拖拽顺序（默认=客观序）
  const [subList, setSubList] = useState<SubjectiveBoardEntry[]>([]);

  useEffect(() => {
    void loadDualLeaderboard(stage, jobType);
  }, [loadDualLeaderboard, stage, jobType]);

  useEffect(() => {
    if (dualLeaderboard) {
      setSubList(dualLeaderboard.subjective.map((e, i) => ({ ...e, dragRank: i + 1 })));
    }
  }, [dualLeaderboard]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const divergentIds = useMemo(() => {
    const m = new Set<string>();
    for (const e of subList) {
      if (e.objectiveRank !== e.dragRank) m.add(e.agentId);
    }
    return m;
  }, [subList]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = subList.findIndex((e) => e.agentId === active.id);
    const newIndex = subList.findIndex((e) => e.agentId === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const moved = subList[oldIndex];
    const reordered = arrayMove(subList, oldIndex, newIndex).map((e, i) => ({
      ...e,
      dragRank: i + 1,
    }));
    setSubList(reordered);

    // 偏好回灌（一次梯度下降步）
    void onReorder(moved.agentId, oldIndex + 1, newIndex + 1, {
      stage,
      jobType: jobType === 'all' ? 'code' : jobType,
    });

    // 双榜拖拽锚点回填 Layer3（拖拽置顶候选 = 当前 rank 1）
    const top = reordered[0];
    void setAnchor(top.agentId, 'dual_leaderboard_drag');
  }

  if (!dualLeaderboard) {
    return (
      <p className="text-[13px] text-gray-400">{t('evaluation.dual.loading', '加载双 Leaderboard…')}</p>
    );
  }

  return (
    <div className="flex flex-wrap gap-4">
      {/* 客观榜 */}
      <BoardCard title={t('evaluation.dual.objBoardTitle', '客观榜（按客观分排序，不可拖拽）')}>
        <ul className="space-y-1.5">
          {dualLeaderboard.objective.length === 0 ? (
            <li className="rounded-xl border border-dashed border-gray-300 px-3 py-4 text-center text-[12px] text-gray-400">
              {t('evaluation.dual.objEmpty', '暂无客观榜数据。')}
            </li>
          ) : (
            dualLeaderboard.objective.map((e) => (
              <li
                key={e.agentId}
                className="flex items-center justify-between rounded-xl bg-white/70 px-3 py-2 dark:bg-white/5"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-bold text-[#1A1C1E] dark:text-white">
                    #{e.rank} {e.name || e.agentId}
                  </p>
                  <p className="text-[11px] text-gray-400">
                    {t('evaluation.dual.objScorePre', '客观分')} {e.objectiveScore.toFixed(1)}
                  </p>
                </div>
                <span
                  className={`ml-2 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    TIER_CLS[e.tier] ?? TIER_CLS.NORMAL
                  }`}
                >
                  {e.tier}
                </span>
              </li>
            ))
          )}
        </ul>
      </BoardCard>

      {/* 主观榜（可拖拽） */}
      <BoardCard title={t('evaluation.dual.subBoardTitle', '主观榜（拖拽重排 = 偏好 overlay）')}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={subList.map((e) => e.agentId)} strategy={verticalListSortingStrategy}>
            <ul className="space-y-1.5">
              {subList.length === 0 ? (
                <li className="rounded-xl border border-dashed border-gray-300 px-3 py-4 text-center text-[12px] text-gray-400">
                  {t('evaluation.dual.subEmpty', '暂无主观榜数据。')}
                </li>
              ) : (
                subList.map((e, i) => (
                  <SortableRow
                    key={e.agentId}
                    entry={e}
                    divergent={divergentIds.has(e.agentId)}
                    rank={i + 1}
                  />
                ))
              )}
            </ul>
          </SortableContext>
        </DndContext>
        <Separator className="my-2 bg-white/60 dark:bg-white/10" />
        <p className="px-1 text-[11px] text-gray-400">
          {t('evaluation.dual.dragNote', '拖拽仅为偏好 overlay，不改客观结论。高亮项 = 客观序与拖拽序发散（Δ 为位移）。')}
        </p>
      </BoardCard>
    </div>
  );
}

export default DualLeaderboard;
