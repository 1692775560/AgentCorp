/**
 * src/pages/Office/AgentDispatchDrawer.tsx
 * 点选像素办公室里的 agent 后弹出的派活抽屉。
 * 复用 officeWork store（走 gateway chat.send 真实调度），展示状态/产出。
 */
import { useState } from 'react';
import { X, Send, Loader2, CheckCircle2, AlertTriangle, RotateCcw } from 'lucide-react';

import type { OfficeEmployee } from '@/engine/office/assignment';
import { VERDICT_META } from '@/engine/office/assignment';
import { useOfficeWorkStore, type WorkStatus } from '@/stores/officeWork';

const STATUS_META: Record<WorkStatus, { label: string; color: string }> = {
  idle: { label: '空闲', color: '#9ca3af' },
  working: { label: '工作中', color: '#3b82f6' },
  done: { label: '已完成', color: '#22c55e' },
  failed: { label: '失败', color: '#ef4444' },
};

export function AgentDispatchDrawer({ emp, onClose }: { emp: OfficeEmployee; onClose: () => void }) {
  const record = useOfficeWorkStore((s) => s.records[emp.agentId]);
  const dispatch = useOfficeWorkStore((s) => s.dispatch);
  const reset = useOfficeWorkStore((s) => s.reset);
  const [draft, setDraft] = useState('');

  const status: WorkStatus = record?.status ?? 'idle';
  const sm = STATUS_META[status];
  const working = status === 'working';
  const verdict = VERDICT_META[emp.verdict];

  const onSend = () => {
    if (working || draft.trim().length === 0) return;
    void dispatch(emp.agentId, emp.sessionKey, draft);
    setDraft('');
  };

  return (
    <>
      {/* 遮罩 */}
      <div className="absolute inset-0 z-10 bg-black/20" onClick={onClose} />
      {/* 抽屉 */}
      <div
        className="glass-panel absolute right-0 top-0 z-20 flex h-full w-full max-w-sm flex-col gap-4 overflow-y-auto p-5"
        style={{ borderTopLeftRadius: 16, borderBottomLeftRadius: 16 }}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-[16px] font-bold" style={{ color: 'var(--neu-ink)' }} translate="no">{emp.name}</h3>
              <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ backgroundColor: `${verdict.color}22`, color: verdict.color }} translate="no">
                {verdict.glyph} {verdict.label}
              </span>
            </div>
            <p className="mt-0.5 text-[12px]" style={{ color: 'var(--neu-ink-soft)' }}>{emp.bio}</p>
            <span className="mt-1 flex items-center gap-1 text-[11px]" style={{ color: sm.color }}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: sm.color }} />
              {sm.label}
            </span>
          </div>
          <button type="button" onClick={onClose} className="neu-btn flex h-7 w-7 items-center justify-center rounded-lg" style={{ color: 'var(--neu-ink-soft)' }}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 结果区 */}
        {record && (status === 'done' || status === 'failed') && (
          <div className="neu-inset flex flex-col gap-2 rounded-xl p-3">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold">
              {status === 'done' ? (
                <CheckCircle2 className="h-4 w-4" style={{ color: '#22c55e' }} />
              ) : (
                <AlertTriangle className="h-4 w-4" style={{ color: '#ef4444' }} />
              )}
              <span className="truncate" style={{ color: 'var(--neu-ink)' }}>任务：{record.task}</span>
              {typeof record.latencyMs === 'number' && (
                <span className="ml-auto shrink-0 text-[10px] tabular-nums" style={{ color: 'var(--neu-ink-soft)', fontFamily: 'var(--font-accent)' }}>
                  {(record.latencyMs / 1000).toFixed(1)}s
                </span>
              )}
            </div>
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-relaxed" style={{ color: status === 'failed' ? '#ef4444' : 'var(--neu-ink-soft)' }}>
              {status === 'done' ? record.reply : record.error ?? '执行失败'}
            </p>
            <button type="button" onClick={() => reset(emp.agentId)} className="neu-btn flex items-center gap-1 self-start rounded-lg px-2 py-1 text-[11px]" style={{ color: 'var(--neu-ink-soft)' }}>
              <RotateCcw className="h-3 w-3" />
              再派一个任务
            </button>
          </div>
        )}

        {/* 输入区 */}
        {status !== 'done' && status !== 'failed' && (
          <div className="mt-auto flex flex-col gap-2">
            <textarea
              value={draft}
              disabled={working || !emp.sessionKey}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSend();
              }}
              placeholder={emp.sessionKey ? '给 TA 派一个任务…（⌘/Ctrl+Enter 发送）' : '该 agent 无会话键，暂不可派活'}
              rows={4}
              className="neu-inset w-full resize-none rounded-xl px-3 py-2 text-[13px] outline-none disabled:opacity-60"
              style={{ color: 'var(--neu-ink)', backgroundColor: 'transparent' }}
            />
            <button
              type="button"
              onClick={onSend}
              disabled={working || !emp.sessionKey || draft.trim().length === 0}
              className="neu-btn flex items-center justify-center gap-2 rounded-xl py-2 text-[13px] font-semibold disabled:opacity-50"
              style={{ color: 'var(--neu-ink)' }}
            >
              {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {working ? '正在真实调度…' : '派发任务'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
