/**
 * src/pages/Office/OfficeEmployeeCard.tsx
 * Office 办公室 · 单个入职员工卡片（凸起 glass 卡）。
 * 展示：头像、姓名、工种、verdict 徽章、一句话简介、六维条形摘要、user_fit。
 * 纯展示组件，数据来自 assignment 引擎的 OfficeEmployee。
 */
import type { OfficeEmployee } from '@/engine/office/assignment';
import { VERDICT_META } from '@/engine/office/assignment';
import type { RadarScore } from '@/types/evaluation';

const RADAR_DIMS: Array<{ key: keyof RadarScore; label: string }> = [
  { key: 'task', label: '任务' },
  { key: 'quality', label: '质量' },
  { key: 'comm', label: '沟通' },
  { key: 'creativity', label: '创意' },
  { key: 'reliability', label: '可靠' },
  { key: 'cost', label: '性价比' },
];

const JOB_LABEL: Record<string, string> = {
  code: 'code · 工程',
  image: 'image · 设计',
  text: 'text · 文案',
};

function initials(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 2) : '？';
}

export function OfficeEmployeeCard({ emp, accent }: { emp: OfficeEmployee; accent: string }) {
  const verdict = VERDICT_META[emp.verdict];
  return (
    <div
      className="glass-panel flex flex-col gap-3 rounded-2xl p-4"
      style={emp.isMvp ? { boxShadow: `0 0 0 1.5px ${accent}55, var(--neu-shadow, 0 0 0 transparent)` } : undefined}
    >
      {/* 头部：头像 + 名字 + verdict */}
      <div className="flex items-center gap-3">
        <div
          className="neu-inset flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-semibold"
          style={{ color: accent }}
          translate="no"
        >
          {emp.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={emp.avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            initials(emp.name)
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="truncate text-[15px] font-semibold"
              style={{ color: 'var(--neu-ink)' }}
              translate="no"
            >
              {emp.name}
            </span>
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
              style={{ backgroundColor: `${verdict.color}22`, color: verdict.color }}
              translate="no"
            >
              {verdict.glyph} {verdict.label}
            </span>
          </div>
          {emp.jobType && (
            <span
              className="text-[11px]"
              style={{ color: 'var(--neu-ink-soft)', fontFamily: 'var(--font-accent)' }}
              translate="no"
            >
              {JOB_LABEL[emp.jobType] ?? emp.jobType}
            </span>
          )}
        </div>
      </div>

      {/* 简介 */}
      <p className="line-clamp-2 text-[12.5px] leading-relaxed" style={{ color: 'var(--neu-ink-soft)' }}>
        {emp.bio}
      </p>

      {/* 六维条形摘要 */}
      <div className="flex flex-col gap-1.5">
        {RADAR_DIMS.map((dim) => {
          const v = emp.radar[dim.key] ?? 0;
          const pct = Math.max(0, Math.min(100, (v / 5) * 100));
          return (
            <div key={dim.key} className="flex items-center gap-2">
              <span className="w-9 shrink-0 text-[10px]" style={{ color: 'var(--neu-ink-soft)' }}>
                {dim.label}
              </span>
              <div className="neu-inset h-1.5 flex-1 overflow-hidden rounded-full">
                <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: accent }} />
              </div>
              <span
                className="w-6 shrink-0 text-right text-[10px] tabular-nums"
                style={{ color: 'var(--neu-ink-soft)', fontFamily: 'var(--font-accent)' }}
              >
                {v.toFixed(1)}
              </span>
            </div>
          );
        })}
      </div>

      {/* user_fit 页脚 */}
      <div className="flex items-center justify-between border-t pt-2" style={{ borderColor: 'color-mix(in srgb, var(--neu-ink-soft) 16%, transparent)' }}>
        <span className="text-[10.5px]" style={{ color: 'var(--neu-ink-soft)' }}>
          用户契合度
        </span>
        <span className="text-[13px] font-bold tabular-nums" style={{ color: accent, fontFamily: 'var(--font-accent)' }}>
          {emp.userFit}
          <span className="text-[10px] font-normal" style={{ color: 'var(--neu-ink-soft)' }}>
            /100
          </span>
        </span>
      </div>
    </div>
  );
}
