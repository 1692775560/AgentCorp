/**
 * src/components/evaluation/SubjectiveScorePanel.tsx
 * 主观打分通道（T6，架构 §2.2 / PRD §5.2）。
 *
 * 针对本阶段启用的 sub_* 维（来自 registry.SUBJECTIVE_DIMS[stage]）渲染滑块，
 * 0–5 分、0.5 步进；变更即写入 scoringStore.onScore（回灌 StageScore.subjective）。
 * 不污染客观排名（遵守 O8 公平性红线）。
 */
import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import { useScoringStore } from '@/stores/scoringStore';
import { SUBJECTIVE_DIMS } from '@/engine/scoring/registry';
import type { StageKey, SubjectiveDim } from '@/types/evaluation';

interface Props {
  agentId: string;
  stage: StageKey;
  /** sub_* 维中文标签（可选，缺省用维键名） */
  labels?: Partial<Record<SubjectiveDim, string>>;
}

const DEFAULT_LABELS: Partial<Record<SubjectiveDim, string>> = {
  sub_potential: '潜力',
  sub_aesthetic_lean: '审美倾向',
  sub_task_feel: '任务契合感',
  sub_communication: '沟通',
  sub_surprise: '惊喜度',
  sub_trust: '信任度',
  sub_rehire: '复聘意愿',
};

export function SubjectiveScorePanel({ agentId, stage, labels }: Props) {
  const dims = SUBJECTIVE_DIMS[stage] as SubjectiveDim[];
  const getSubjective = useScoringStore((s) => s.getSubjective);
  const onScore = useScoringStore((s) => s.onScore);

  const current = useMemo(() => getSubjective(agentId, stage), [getSubjective, agentId, stage]);

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="subtitle1" gutterBottom>
        主观打分 · {stage}（{agentId}）
      </Typography>
      <Typography variant="caption" color="text.secondary">
        0–5 分，0.5 步进。仅用于主观榜单与偏好回灌，不进入客观排名。
      </Typography>
      <Stack spacing={2} sx={{ mt: 1 }}>
        {dims.map((dim) => {
          const value = current[dim] ?? 3;
          return (
            <Box key={dim}>
              <Typography variant="body2">
                {labels?.[dim] ?? DEFAULT_LABELS[dim] ?? dim}
                <span style={{ color: '#888' }}>：{value.toFixed(1)}</span>
              </Typography>
              <Slider
                value={value}
                min={0}
                max={5}
                step={0.5}
                marks
                valueLabelDisplay="auto"
                onChange={(_, v) => onScore(agentId, stage, dim, v as number)}
              />
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}

export default SubjectiveScorePanel;
