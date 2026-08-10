/**
 * src/services/judgeEnsemble.ts
 * 裁判 ensemble（模块 C · 评估中心可靠性底座；T07 增量）。
 *
 * 单次 chat-judge 噪声大（见 passK.ts 设计依据），故对同一条 transcript 重复裁判 k 次，
 * 再做聚合：
 * - aggregateRadars：逐维均值雷达（抑制单次抖动）；
 * - majorityVerdict：多数裁决 verdict（k 次里出现最多的判定）；
 * - 平均 confidence；
 * - passK：k 次重复的 pass^k 可靠性结论（核心差异化指标）。
 *
 * 跨家族扩展点：`models` 数组预留。当前后端 /api/chat-judge 契约仅接受
 * (agent_id, transcript)，未暴露 model 字段，故默认走"同模型重复采样"；
 * 后端支持逐模型调用后，可在 k 次循环里按 models 轮转实现跨家族交叉验证，
 * 无需改动调用方。
 *
 * 顺序交换去位置偏差：pairwise 比较（arena）的位置偏差在此单样本评分场景不显著，
 * 但 ensemble 的"重复采样 + 均值 + 多数裁决"本身即对位置/初始化的去偏。
 * 后续若接入 arenaCompareEnsemble，可在此追加 A/B 顺序交换分支。
 *
 * 全部为纯函数 + 一次异步编排；judgeChat 失败（离线/503）返回 null，由调用方降级。
 */
import type { BossProfile, RadarScore, Verdict } from '@/types/evaluation';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import { judgeChat } from '@/services/judgeClient';
import { passK, type PassKResult } from '@/engine/evaluation/passK';

/** judge ensemble 选项 */
export interface JudgeEnsembleOptions {
  /** 重复运行次数（默认 3） */
  k?: number;
  /**
   * 跨家族模型列表（扩展点）。
   * 当前占位：后端未接受 model 字段，始终用同一裁判；后端支持后可逐模型调用。
   */
  models?: string[];
  /** 单维通过阈值（透传给 passK） */
  threshold?: number;
  /**
   * A · 老板原型（用户个性化）：透传给 judgeChat，使其在前缀注入「评估上下文」，
   * 实现 Wang 的个性化评估——同一 agent 对不同老板表现不同。
   */
  persona?: BossProfile | null;
}

/** judge ensemble 结果 */
export interface JudgeEnsembleResult {
  /** judge = 真实裁判；degraded = 至少一次回退（前端应据此决定展示优先级） */
  source: 'judge' | 'degraded';
  /** 每次运行的雷达（已过滤掉 null） */
  radars: RadarScore[];
  /** 多次运行均值雷达 */
  meanRadar: RadarScore;
  /** 多数裁决 verdict */
  verdict: Verdict | null;
  /** 平均置信度（0–1） */
  confidence: number;
  /** pass^k 可靠性结论 */
  passK: PassKResult;
  /** 去重后的证据留痕 */
  evidence_trace: string[];
}

/** 全零六维 */
function emptyRadar(): RadarScore {
  return { task: 0, quality: 0, comm: 0, creativity: 0, reliability: 0, cost: 0 };
}

/** 多个雷达逐维平均（纯函数，可单测） */
export function aggregateRadars(radars: RadarScore[]): RadarScore {
  const out = emptyRadar();
  const valid = radars.filter((r): r is RadarScore => Boolean(r) && typeof r === 'object');
  if (valid.length === 0) return out;
  for (const dim of RADAR_DIMS) {
    const sum = valid.reduce((acc, r) => acc + (r[dim] ?? 0), 0);
    out[dim] = Math.round((sum / valid.length) * 10) / 10;
  }
  return out;
}

/** 多数裁决（纯函数，可单测）：返回出现次数最多的 verdict；平票取首次出现 */
export function majorityVerdict(verdicts: (Verdict | null | undefined)[]): Verdict | null {
  const counts: Partial<Record<Verdict, number>> = {};
  for (const v of verdicts) {
    if (!v) continue;
    counts[v] = (counts[v] ?? 0) + 1;
  }
  let best: Verdict | null = null;
  let bestCount = 0;
  for (const v of Object.keys(counts) as Verdict[]) {
    const c = counts[v] ?? 0;
    if (c > bestCount) {
      bestCount = c;
      best = v;
    }
  }
  return best;
}

/**
 * B · 跨「同原型多 session」全对判定（纯函数，可单测）。
 * 可靠性 pass^k 升级为：同一 boss 原型下，agent 必须在**每一段独立会话**里都达标，
 * 才算「可靠」——避免把单次幸运达标当成稳健。任一段不过 → 不可靠。
 * 调用方应保证入参为 ≥2 段会话的判定；空数组按空真返回 true（由调用方把关）。
 */
export function allPassAcrossSessions(perSessionPass: boolean[]): boolean {
  if (perSessionPass.length === 0) return true;
  return perSessionPass.every(Boolean);
}

/**
 * 对同一条 transcript 重复调用裁判 k 次并聚合。
 *
 * @returns 聚合结果；k 次全部失败（无有效雷达）时返回 null（调用方降级处理）。
 */
export async function judgeChatEnsemble(
  agentId: string,
  transcript: string,
  opts?: JudgeEnsembleOptions,
): Promise<JudgeEnsembleResult | null> {
  const k = opts?.k ?? 3;
  const threshold = opts?.threshold ?? 3.5;

  const radars: RadarScore[] = [];
  const verdicts: (Verdict | null)[] = [];
  const confidences: number[] = [];
  const evidence: string[] = [];
  let anyJudge = false;

  for (let i = 0; i < k; i += 1) {
    const res = await judgeChat(agentId, transcript, opts?.persona).catch(() => null);
    if (!res || !res.radar) continue;
    radars.push(res.radar);
    if (res.verdict) verdicts.push(res.verdict);
    if (typeof res.confidence === 'number') confidences.push(res.confidence);
    if (res.source === 'judge') anyJudge = true;
    if (Array.isArray(res.evidence_trace)) evidence.push(...res.evidence_trace);
  }

  if (radars.length === 0) return null;

  const meanRadar = aggregateRadars(radars);
  const verdict = majorityVerdict(verdicts);
  const confidence = confidences.length
    ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
    : 0;
  const pk = passK(radars, { k: radars.length, threshold });

  return {
    source: anyJudge ? 'judge' : 'degraded',
    radars,
    meanRadar,
    verdict,
    confidence,
    passK: pk,
    evidence_trace: Array.from(new Set(evidence)),
  };
}

export default judgeChatEnsemble;
