/**
 * src/engine/evaluation/evalSuite.ts
 * C · 基准套件引擎（Benchmark suites instead of leaderboards, Wang et al. 2024）。
 *
 * 单数字排行榜会掩盖权衡与危害；AgentCorp 据此把「对一位 agent 的评估」重组为
 * 一个**套件矩阵**：维度（六维）× 老板原型（与谁协作）。核心产出：
 *  - computePersonaSuite：维度×原型矩阵 + 跨原型均值雷达 + 逐维波动；
 *  - personalizationDelta：|中性基线 − 原型雷达| 的逐维与总均值（0–5）。
 *    高 → 该 agent 的表现随「与谁协作」显著漂移（Tay 式风险信号，Wang 的 sock-puppet 实证）；
 *  - fitForProfile：按老板原型强调维加权的契合度（0–100），即 D 的 per-user FIT 雏形。
 *
 * 全部为纯函数、无副作用（不读 store / 不发网络），可直接单测。
 */
import type { BossProfile, RadarScore, RadarDim } from '@/types/evaluation';
import { NEUTRAL_BOSS } from '@/types/evaluation';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import { bossPersonaBoost } from '@/engine/interview/questionBank';

/** 套件中的一列：一个老板原型下的评估结果 */
export interface PersonaColumn {
  /** BossProfile.id（'neutral' = 无个性化基线） */
  profileId: string;
  /** 展示名 */
  name: string;
  /** 该原型下的六维雷达（尚未评估为 null） */
  radar: RadarScore | null;
  /** 该原型下的契合度 0–100（按原型强调维加权）；无雷达为 null */
  fit: number | null;
}

/** 人格化评估套件（维度 × 原型矩阵） */
export interface PersonaSuite {
  agentId: string;
  /** 维度顺序（展示用） */
  dims: RadarDim[];
  /** 列：每个老板原型一列（含 neutral 锚点） */
  columns: PersonaColumn[];
  /** 中性基线雷达（对照锚点；缺失为 null） */
  neutral: RadarScore | null;
  /** 跨原型逐维均值雷达（揭示「平均表现」） */
  meanRadar: RadarScore;
  /** 个性化增量：各原型相对中性基线的最大逐维漂移 + 总均值（0–5，越高越「看人下菜」） */
  personalizationDelta: { perDim: Partial<Record<RadarDim, number>>; total: number };
  /** 跨原型逐维波动（max−min）→ 稳定性风险（越高越「对谁说都不一样」） */
  dimVolatility: Partial<Record<RadarDim, number>>;
}

/** 零值雷达（累加均值用） */
const ZERO_RADAR: RadarScore = {
  task: 0,
  quality: 0,
  comm: 0,
  creativity: 0,
  reliability: 0,
  cost: 0,
};

/**
 * 按老板原型强调维加权的契合度（0–100）。
 * 中性原型（无强调）→ 权重全 1 → 退化为六维均值；个性化原型 → 被强调维权重更高。
 * 这正是 D · per-user FIT 的单原型实现；套件视图逐个原型调用它。
 */
export function fitForProfile(
  radar: RadarScore | null,
  profile: BossProfile | null,
): number | null {
  if (!radar) return null;
  const boost = bossPersonaBoost(profile); // 中性/无 → {}
  let wSum = 0;
  let acc = 0;
  for (const d of RADAR_DIMS) {
    const w = (boost as Record<string, number | undefined>)[d] ?? 1;
    wSum += w;
    acc += w * radar[d];
  }
  if (wSum === 0) return null;
  return Math.round((acc / wSum / 5) * 100);
}

/**
 * 个性化增量：|中性基线 − 原型雷达| 的逐维绝对差与总均值（0–5）。
 * 任一侧缺失 → 返回全 0（无法计算漂移）。
 */
export function personalizationDelta(
  neutral: RadarScore | null,
  persona: RadarScore | null,
): { perDim: Partial<Record<RadarDim, number>>; total: number } {
  const perDim: Partial<Record<RadarDim, number>> = {};
  if (!neutral || !persona) return { perDim, total: 0 };
  let sum = 0;
  for (const d of RADAR_DIMS) {
    const diff = Math.abs(neutral[d] - persona[d]);
    perDim[d] = Math.round(diff * 100) / 100;
    sum += diff;
  }
  return { perDim, total: Math.round((sum / RADAR_DIMS.length) * 100) / 100 };
}

/**
 * 由「按原型存 radar」的落库结构，计算人格化评估套件。
 *
 * @param radarByPersona EvaluationProfile.radarByPersona（键 = BossProfile.id）
 * @param profiles 参与套件的老板原型表（含 neutral），决定列顺序与展示名
 */
export function computePersonaSuite(params: {
  agentId: string;
  radarByPersona: Record<string, RadarScore> | undefined;
  profiles: BossProfile[];
}): PersonaSuite {
  const { agentId, radarByPersona, profiles } = params;
  const map = radarByPersona ?? {};

  const columns: PersonaColumn[] = profiles.map((p) => {
    const radar = map[p.id] ?? null;
    return {
      profileId: p.id,
      name: p.name ?? p.id,
      radar,
      fit: fitForProfile(radar, p),
    };
  });

  const neutral = map[NEUTRAL_BOSS.id] ?? null;

  // 逐维均值 + 波动（仅统计有雷达的列）
  const valid = columns.filter((c) => c.radar);
  const meanRadar: RadarScore = { ...ZERO_RADAR };
  const dimVolatility: Partial<Record<RadarDim, number>> = {};
  if (valid.length > 0) {
    for (const d of RADAR_DIMS) {
      const vals = valid.map((c) => c.radar![d]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      meanRadar[d] = Math.round(mean * 100) / 100;
      dimVolatility[d] = Math.round((Math.max(...vals) - Math.min(...vals)) * 100) / 100;
    }
  }

  // 个性化增量：逐原型与中性基线比较，取每个维度的最大漂移
  const perDim: Partial<Record<RadarDim, number>> = {};
  if (neutral) {
    for (const c of columns) {
      if (c.profileId === NEUTRAL_BOSS.id || !c.radar) continue;
      const { perDim: pd } = personalizationDelta(neutral, c.radar);
      for (const d of RADAR_DIMS) {
        const v = pd[d] ?? 0;
        if (v > (perDim[d] ?? 0)) perDim[d] = v;
      }
    }
  }
  const total = Math.round(
    (RADAR_DIMS.reduce((a, d) => a + (perDim[d] ?? 0), 0) / RADAR_DIMS.length) * 100,
  ) / 100;

  return {
    agentId,
    dims: [...RADAR_DIMS],
    columns,
    neutral,
    meanRadar,
    personalizationDelta: { perDim, total },
    dimVolatility,
  };
}
