/**
 * src/pages/Office/OfficeEmployeeCard.tsx
 * Office 办公室 · 单个入职员工卡片（凸起 glass 卡）。
 * 展示：头像、姓名、工种、verdict 徽章、简介、六维摘要、user_fit。
 * 派活：底部工作区可对该在岗 agent 真实下发任务（走 officeWork store →
 * gateway.rpc('chat.send')），并回填状态（工作中/完成/失败）与产出。
 */
import { useState } from 'react';
import { Send, Loader2, CheckCircle2, AlertTriangle, RotateCcw } from 'lucide-react';

import type { OfficeEmployee } from '@/engine/office/assignment';
import { VERDICT_META } from '@/engine/office/assignment';
import { useOfficeWorkStore, type WorkStatus } from '@/stores/officeWork';
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

const STATUS_META: Record<WorkStatus, { label: string; color: string }> = {
  idle: { label: '空闲', color: '#9ca3af' },
  working: { label: '工作中', color: '#3b82f6' },
  done: { label: '已完成', color: '#22c55e' },
  failed: { label: '失败', color: '#ef4444' },
};

function initials(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 2) : '？';
}

export function OfficeEmployeeCard({ emp, accent }: { emp: OfficeEmployee; accent: string }) {
  const verdict = VERDICT_META[emp.verdict];
  const record = useOfficeWorkStore((s) => s.records[emp.agentId]);
  const dispatch = useOfficeWorkStore((s) => s.dispatch);
  const reset = useOfficeWorkStore((s) => s.reset);
  const [draft, setDraft] = useState('');

  const status: WorkStatus = record?.status ?? 'idle';
  const statusMeta = STATUS_META[status];
  const working = status === 'working';

  const onSend = () => {
    if (working || draft.trim().length === 0) return;
    void dispatch(emp.agentId, emp.sessionKey, draft);
    setDraft('');
  };

  return (
    <div
      className="glass-panel flex flex-col gap-3 rounded-2xl p-4"
      style={emp.isMvp ? { boxShadow: `0 0 0 1.5px ${accent}55, var(--neu-shadow, 0 0 0 transparent)` } : undefined}
    >
      {/* 头部：头像 + 名字 + verdict + 工作状态点 */}
      <div className="flex items-center gap-3">
        <div
          className="neu-inset flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-semibold"
          style={{ color: accent }}
          translate="no"
        >
          {emp.avatar ? (
            <img src={emp.avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            initials(emp.name)
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold" style={{ color: 'var(--neu-ink)' }} translate="no">
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
          <div className="flex items-center gap-2">
            {emp.jobType && (
              <span
                className="text-[11px]"
                style={{ color: 'var(--neu-ink-soft)', fontFamily: 'var(--font-accent)' }}
                translate="no"
              >
                {JOB_LABEL[emp.jobType] ?? emp.jobType}
              </span>
            )}
            <span className="flex items-center gap-1 text-[11px]" style={{ color: statusMeta.color }}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: statusMeta.color }} />
              {statusMeta.label}
            </span>
          </div>
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
      <div
        className="flex items-center justify-between border-t pt-2"
        style={{ borderColor: 'color-mix(in srgb, var(--neu-ink-soft) 16%, transparent)' }}
      >
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

      {/* 派活工作区 */}
      <WorkPanel
        accent={accent}
        status={status}
        record={record}
        draft={draft}
        setDraft={setDraft}
        working={working}
        canDispatch={!!emp.sessionKey}
        onSend={onSend}
        onReset={() => reset(emp.agentId)}
      />
    </div>
  );
}

function WorkPanel(props: {
  accent: string;
  status: WorkStatus;
  record: ReturnType<typeof useOfficeWorkStore.getState>['records'][string] | undefined;
  draft: string;
  setDraft: (v: string) => void;
  working: boolean;
  canDispatch: boolean;
  onSend: () => void;
  onReset: () => void;
}) {
  const { accent, status, record, draft, setDraft, working, canDispatch, onSend, onReset } = props;

  return (
    <div
      className="flex flex-col gap-2 border-t pt-3"
      style={{ borderColor: 'color-mix(in srgb, var(--neu-ink-soft) 16%, transparent)' }}
    >
      {/* 结果区（done / failed 时显示最近任务与产出） */}
      {record && (status === 'done' || status === 'failed') && (
        <div className="neu-inset flex flex-col gap-1.5 rounded-xl p-2.5">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold">
            {status === 'done' ? (
              <CheckCircle2 className="h-3.5 w-3.5" style={{ color: '#22c55e' }} />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5" style={{ color: '#ef4444' }} />
            )}
            <span className="truncate" style={{ color: 'var(--neu-ink)' }}>
              任务：{record.task}
            </span>
            {typeof record.latencyMs === 'number' && (
              <span
                className="ml-auto shrink-0 text-[10px] tabular-nums"
                style={{ color: 'var(--neu-ink-soft)', fontFamily: 'var(--font-accent)' }}
              >
                {(record.latencyMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          <p
            className="max-h-28 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed"
            style={{ color: status === 'failed' ? '#ef4444' : 'var(--neu-ink-soft)' }}
          >
            {status === 'done' ? record.reply : record.error ?? '执行失败'}
          </p>
          <button
            type="button"
            onClick={onReset}
            className="neu-btn flex items-center justify-center gap-1 self-start rounded-lg px-2 py-1 text-[11px]"
            style={{ color: 'var(--neu-ink-soft)' }}
          >
            <RotateCcw className="h-3 w-3" />
            再派一个任务
          </button>
        </div>
      )}

      {/* 输入区（idle / working / 结果后仍可再派：结果区已提供按钮，这里在非结果态显示） */}
      {status !== 'done' && status !== 'failed' && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft}
            disabled={working || !canDispatch}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSend();
            }}
            placeholder={canDispatch ? '给 TA 派一个任务…' : '该 agent 无会话键，暂不可派活'}
            className="neu-inset min-w-0 flex-1 rounded-xl px-3 py-1.5 text-[12px] outline-none disabled:opacity-60"
            style={{ color: 'var(--neu-ink)', backgroundColor: 'transparent' }}
          />
          <button
            type="button"
            onClick={onSend}
            disabled={working || !canDispatch || draft.trim().length === 0}
            className="neu-btn flex h-8 w-8 shrink-0 items-center justify-center rounded-xl disabled:opacity-50"
            style={{ color: accent }}
            aria-label="派发任务"
          >
            {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      )}

      {working && (
        <span className="text-[11px]" style={{ color: 'var(--neu-ink-soft)' }}>
          正在真实调度该 agent 执行任务…
        </span>
      )}
    </div>
  );
}
