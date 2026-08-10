/**
 * src/components/evaluation/SuiteView.tsx
 * C · 基准套件视图（Benchmark suites instead of leaderboards）。
 *
 * 把「对一位 agent 的评估」从单数字排行榜重组成维度×原型矩阵：
 *  - 行 = 六维；列 = 各老板原型（中性基线列高亮为对照锚点）；
 *  - 单元格 = 该原型下该维度的雷达分（绿/琥珀/玫红着色，揭示权衡而非藏进总分）；
 *  - 列头 = 该原型下的 per-user FIT（按原型强调维加权的契合度）；
 *  - 底部 = 个性化增量（personalization delta）：相对中性基线的最大逐维漂移，
 *    高 → 该 agent「对谁说都不一样」（Tay 式漂移风险信号）。
 *
 * 设计：纯展示组件，由父级传入 radarByPersona 与原型表，内部用 computePersonaSuite 计算。
 */
import { useMemo } from 'react';
import type { BossProfile, RadarScore } from '@/types/evaluation';
import { NEUTRAL_BOSS } from '@/types/evaluation';
import {
  computePersonaSuite,
  type PersonaSuite,
} from '@/engine/evaluation/evalSuite';
import { RADAR_DIM_LABELS } from '@/engine/marketplace/radarSource';

/** 分数着色（0–5 → 语义色），与评估页既有 emerald/amber/rose 范式一致 */
function scoreClass(v: number | null): string {
  if (v === null) return 'text-gray-300 dark:text-gray-600';
  if (v >= 4) return 'text-emerald-600 dark:text-emerald-400';
  if (v >= 2.5) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}
function cellBg(v: number | null): string {
  if (v === null) return 'bg-white/40 dark:bg-white/5';
  if (v >= 4) return 'bg-emerald-50 dark:bg-emerald-500/10';
  if (v >= 2.5) return 'bg-amber-50 dark:bg-amber-500/10';
  return 'bg-rose-50 dark:bg-rose-500/10';
}

/** 个性化增量风险等级（0–5 总均值） */
function deltaRisk(total: number): { label: string; cls: string; ring: string } {
  if (total >= 1.5)
    return {
      label: '高漂移 · 看人下菜',
      cls: 'text-rose-600 dark:text-rose-400',
      ring: 'border-rose-300 dark:border-rose-500/40',
    };
  if (total >= 0.6)
    return {
      label: '中漂移 · 略有偏向',
      cls: 'text-amber-600 dark:text-amber-400',
      ring: 'border-amber-300 dark:border-amber-500/40',
    };
  return {
    label: '稳定 · 基本不因人而变',
    cls: 'text-emerald-600 dark:text-emerald-400',
    ring: 'border-emerald-300 dark:border-emerald-500/40',
  };
}

export function SuiteView({
  agentId,
  radarByPersona,
  profiles,
}: {
  agentId: string | null;
  radarByPersona?: Record<string, RadarScore>;
  profiles: BossProfile[];
}) {
  const suite: PersonaSuite | null = useMemo(
    () =>
      agentId
        ? computePersonaSuite({ agentId, radarByPersona, profiles })
        : null,
    [agentId, radarByPersona, profiles],
  );

  if (!suite) return null;

  const evaluatedCols = suite.columns.filter((c) => c.radar);
  const risk = deltaRisk(suite.personalizationDelta.total);

  return (
    <div className="space-y-3 rounded-2xl bg-white/70 p-4 dark:bg-white/5">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-bold text-[#1A1C1E] dark:text-white">
          人格化评估套件 · 维度 × 原型
        </p>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${risk.cls} ${risk.ring}`}
          title="个性化增量 = 相对中性基线的最大逐维漂移（越高越「对谁说都不一样」）"
        >
          Δ {suite.personalizationDelta.total.toFixed(2)} · {risk.label}
        </span>
      </div>

      {evaluatedCols.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-gray-400">
          尚未在任一老板原型下评估。切换左侧「老板原型」并运行评估后，这里会展示同一位 agent
          对不同老板的表现矩阵与个性化增量——避免把权衡藏进单一总分。
        </p>
      ) : (
        <>
          {/* 矩阵：首列维度标签，其后每原型一列 */}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr>
                  <th className="w-16 py-1 text-left text-gray-400">维度</th>
                  {suite.columns.map((c) => (
                    <th
                      key={c.profileId}
                      className={`px-2 py-1 text-center font-bold ${
                        c.profileId === NEUTRAL_BOSS.id
                          ? 'text-[#514a39] dark:text-[#e0e5ec] underline decoration-dotted'
                          : 'text-[#1A1C1E] dark:text-white'
                      }`}
                    >
                      <div className="truncate" style={{ maxWidth: 72 }} title={c.name}>
                        {c.profileId === NEUTRAL_BOSS.id ? '中性' : c.name}
                      </div>
                      {c.fit !== null ? (
                        <div className={`text-[10px] font-normal ${scoreClass(c.fit / 20)}`}>
                          FIT {c.fit}
                        </div>
                      ) : (
                        <div className="text-[10px] font-normal text-gray-300">未评估</div>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {suite.dims.map((dim) => (
                  <tr key={dim} className="border-t border-white/40">
                    <td className="py-1 text-left text-gray-400">{RADAR_DIM_LABELS[dim]}</td>
                    {suite.columns.map((c) => {
                      const v = c.radar ? c.radar[dim] : null;
                      return (
                        <td
                          key={c.profileId}
                          className={`px-2 py-1 text-center font-bold tabular-nums ${cellBg(v)} ${scoreClass(v)} ${
                            c.profileId === NEUTRAL_BOSS.id ? 'border-x border-dashed border-[#514a39]/40 dark:border-[#e0e5ec]/40' : ''
                          }`}
                        >
                          {v === null ? '—' : v.toFixed(1)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 个性化增量逐维（高亮漂移最大的维） */}
          {suite.personalizationDelta.total > 0 ? (
            <div className="space-y-1 rounded-xl border border-white/40 bg-white/40 p-2 dark:bg-white/5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                个性化增量（相对中性基线的最大漂移）
              </p>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {suite.dims.map((dim) => {
                  const d = suite.personalizationDelta.perDim[dim] ?? 0;
                  if (d === 0) return null;
                  return (
                    <span key={dim} className={`text-[11px] ${scoreClass(5 - d)}`}>
                      {RADAR_DIM_LABELS[dim]}: +{d.toFixed(2)}
                    </span>
                  );
                })}
              </div>
            </div>
          ) : null}

          <p className="text-[10px] leading-relaxed text-gray-400">
            套件哲学（Wang 2024）：不把危害藏进单一总分——绿色=稳健、琥珀=中等、玫红=薄弱；
            逐列 FIT 反映「这位老板真正在乎的维」被加权；Δ 高提示该 agent 表现随协作对象显著漂移。
          </p>
        </>
      )}
    </div>
  );
}

export default SuiteView;
