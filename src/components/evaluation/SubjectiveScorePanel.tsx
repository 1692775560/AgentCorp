/**
 * src/components/evaluation/SubjectiveScorePanel.tsx
 * 主观打分通道（T6 → T38 重写，架构 §2.2 / PRD §5.2 / 增量 §8.1）。
 *
 * 针对本阶段启用的 sub_* 维（来自 registry.SUBJECTIVE_DIMS[stage]）渲染滑块，
 * 0–5 分、0.5 步进；变更即写入 scoringStore.onScore（回灌 StageScore.subjective）。
 * 不污染客观排名（遵守 O8 公平性红线）。
 *
 * T38 重写说明（MUI → Radix + Tailwind，零 @mui import）：
 * - Box/Stack       → div + space-y-* 布局；
 * - Typography      → h3/p + Tailwind 文字阶（对齐 Evaluation 页风格）；
 * - Slider          → 原生 <input type="range" min=0 max=5 step=0.5>
 *                     + accent-[#FFD233] + 右侧实时值 + 0..5 刻度行；
 * - 说明提示        → 复用项目已有 ui/tooltip（Radix）。
 * props 契约不变（agentId / stage / labels），调用方零适配。
 */
import { Info } from 'lucide-react';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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

/** 阶段中文名（标题展示用） */
const STAGE_LABELS: Record<StageKey, string> = {
  preScreen: 'S1 初审',
  interview: 'S2 面试',
  performance: 'S3 绩效',
};

/** 刻度行：0 / 1 / 2 / 3 / 4 / 5 */
const TICKS = [0, 1, 2, 3, 4, 5] as const;

export function SubjectiveScorePanel({ agentId, stage, labels }: Props) {
  const dims = SUBJECTIVE_DIMS[stage] as SubjectiveDim[];
  const onScore = useScoringStore((s) => s.onScore);
  // 直接订阅本 agent×stage 的主观分切片，打分后即时重渲染
  const current = useScoringStore(
    (s) => s.subjectiveScores[`${stage}:${agentId}`],
  ) ?? {};

  return (
    <div className="space-y-4 rounded-2xl border border-white/40 bg-white/60 p-4 dark:bg-white/5">
      <div>
        <div className="flex items-center gap-1.5">
          <h3 className="text-[13px] font-bold text-[#1A1C1E] dark:text-white">
            主观打分 · {STAGE_LABELS[stage]}（{agentId}）
          </h3>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="text-gray-400 hover:text-[#1A1C1E] dark:hover:text-white">
                  <Info className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[240px] text-xs">
                主观分仅用于主观榜单与偏好回灌（dimLift → 用户权重），
                不进入客观排名（O8 公平性红线）。
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <p className="mt-0.5 text-[11px] text-gray-400">
          0–5 分，0.5 步进。仅用于主观榜单与偏好回灌，不进入客观排名。
        </p>
      </div>

      <div className="space-y-4">
        {dims.map((dim) => {
          const value = current[dim] ?? 3;
          return (
            <div key={dim}>
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-[#1A1C1E] dark:text-white">
                  {labels?.[dim] ?? DEFAULT_LABELS[dim] ?? dim}
                </span>
                <span className="rounded-full bg-[#FFD233]/20 px-2 py-0.5 text-[11px] font-bold tabular-nums text-[#1A1C1E] dark:text-[#FFD233]">
                  {value.toFixed(1)}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={5}
                step={0.5}
                value={value}
                aria-label={labels?.[dim] ?? DEFAULT_LABELS[dim] ?? dim}
                onChange={(e) => onScore(agentId, stage, dim, Number(e.target.value))}
                className="mt-1.5 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-200 accent-[#FFD233] dark:bg-white/10"
              />
              <div className="mt-0.5 flex justify-between text-[10px] text-gray-400">
                {TICKS.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default SubjectiveScorePanel;
