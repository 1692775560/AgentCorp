/**
 * src/components/evaluation/DualLeaderboard.tsx
 * 双 Leaderboard（T7 + T19，架构 §2.2 / §4.2 / 增量 T19）。
 *
 * - 客观榜：按 objectiveScore 降序（原逻辑，不污染公平排名）。
 * - 主观榜：默认序=客观序预排；用户可用 @dnd-kit 拖拽重排（仅偏好 overlay）。
 * - 自动高亮 divergences（客观序 vs 拖拽序发散）。
 * - 说明：「拖拽仅为偏好 overlay，不改客观结论」。
 *
 * T19 闭合（批次2 落地后回填 Layer3）：每次拖拽除 scoringStore.onReorder（偏好回灌）
 * 外，额外调用 convergenceStore.setAnchor(trace, topCandidateId,
 * "dual_leaderboard_drag")——把拖拽置顶候选回填为 HumanAnchor。若当前无活跃
 * convergence trace，则静默 noop（不报错），与 explicit_pin 源互斥合并。
 */
import React, { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
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

function SortableRow({
  entry,
  divergent,
  rank,
}: {
  entry: SubjectiveBoardEntry;
  divergent: boolean;
  rank: number;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: entry.agentId,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: 'grab',
  };
  return (
    <ListItem
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      sx={{
        border: divergent ? '1px solid #e0a000' : '1px solid transparent',
        borderRadius: 1,
        bgcolor: divergent ? 'rgba(224,160,0,0.08)' : 'background.paper',
      }}
      secondaryAction={
        divergent ? (
          <Chip size="small" color="warning" label={`Δ${entry.dragRank - entry.objectiveRank}`} />
        ) : null
      }
    >
      <ListItemText
        primary={`#${rank} ${entry.name || entry.agentId}`}
        secondary={`主观分 ${entry.subjectiveScore.toFixed(1)} · 客观序 #${entry.objectiveRank}`}
      />
    </ListItem>
  );
}

export function DualLeaderboard({ stage, jobType }: Props) {
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

    // T8：偏好回灌（一次梯度下降步）
    void onReorder(moved.agentId, oldIndex + 1, newIndex + 1, {
      stage,
      jobType: jobType === 'all' ? 'code' : jobType,
    });

    // T19：双榜拖拽锚点回填 Layer3（拖拽置顶候选 = 当前 rank 1）
    const top = reordered[0];
    void setAnchor(top.agentId, 'dual_leaderboard_drag');
  }

  if (!dualLeaderboard) {
    return <Typography variant="body2">加载双 Leaderboard…</Typography>;
  }

  return (
    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
      {/* 客观榜 */}
      <Paper sx={{ flex: 1, minWidth: 280, p: 1.5 }} variant="outlined">
        <Typography variant="subtitle2" gutterBottom>
          客观榜（按客观分排序，不可拖拽）
        </Typography>
        <List dense>
          {dualLeaderboard.objective.map((e) => (
            <ListItem key={e.agentId} divider>
              <ListItemText
                primary={`#${e.rank} ${e.name || e.agentId}`}
                secondary={`客观分 ${e.objectiveScore.toFixed(1)} · ${e.tier}`}
              />
            </ListItem>
          ))}
        </List>
      </Paper>

      {/* 主观榜（可拖拽） */}
      <Paper sx={{ flex: 1, minWidth: 280, p: 1.5 }} variant="outlined">
        <Typography variant="subtitle2" gutterBottom>
          主观榜（拖拽重排 = 偏好 overlay）
        </Typography>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={subList.map((e) => e.agentId)} strategy={verticalListSortingStrategy}>
            <List dense>
              {subList.map((e, i) => (
                <SortableRow key={e.agentId} entry={e} divergent={divergentIds.has(e.agentId)} rank={i + 1} />
              ))}
            </List>
          </SortableContext>
        </DndContext>
        <Divider sx={{ my: 1 }} />
        <Typography variant="caption" color="text.secondary">
          拖拽仅为偏好 overlay，不改客观结论。高亮项 = 客观序与拖拽序发散（Δ 为位移）。
        </Typography>
      </Paper>
    </Box>
  );
}

export default DualLeaderboard;
