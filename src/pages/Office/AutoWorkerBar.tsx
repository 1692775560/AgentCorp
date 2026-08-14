/**
 * src/pages/Office/AutoWorkerBar.tsx
 * 自动任务 worker 控制条（S8/S9/S10）。挂在看板顶部。
 *
 * 展示与控制：开关自动执行、并发度 ±、网关连接状态（真实）、
 * 执行中/已处理计数、最近说明。全部读 useAutoWorkerStore + useGatewayStore，
 * 不引入任何 mock，也不新增存储。
 */
import { useEffect } from 'react';
import { Bot, Loader2, PlugZap, PowerOff } from 'lucide-react';

import { useAutoWorkerStore } from '@/stores/autoWorker';
import { useGatewayStore } from '@/stores/gateway';

export function AutoWorkerBar() {
  const enabled = useAutoWorkerStore((s) => s.enabled);
  const running = useAutoWorkerStore((s) => s.running);
  const note = useAutoWorkerStore((s) => s.note);
  const processed = useAutoWorkerStore((s) => s.processed);
  const concurrency = useAutoWorkerStore((s) => s.concurrency);
  const activeCount = useAutoWorkerStore((s) => s.activeTaskIds.length);
  const enable = useAutoWorkerStore((s) => s.enable);
  const disable = useAutoWorkerStore((s) => s.disable);
  const setConcurrency = useAutoWorkerStore((s) => s.setConcurrency);
  const syncWithGateway = useAutoWorkerStore((s) => s.syncWithGateway);

  const gatewayState = useGatewayStore((s) => s.status.state);
  const initGateway = useGatewayStore((s) => s.init);
  const isInitialized = useGatewayStore((s) => s.isInitialized);

  // 确保网关状态已初始化（这样连接判断是真实的）。
  useEffect(() => {
    if (!isInitialized) void initGateway();
  }, [isInitialized, initGateway]);

  // 网关状态一变化就让 worker 重新对齐（连上→启动，掉线→待命）。
  useEffect(() => {
    syncWithGateway();
  }, [gatewayState, syncWithGateway]);

  const connected = gatewayState === 'running';
  const connLabel = connected
    ? '网关已连接'
    : gatewayState === 'starting' || gatewayState === 'reconnecting'
      ? '网关连接中…'
      : '网关未连接';
  const connColor = connected ? '#22c55e' : gatewayState === 'error' ? '#ef4444' : '#9ca3af';

  return (
    <div className="neu-inset flex shrink-0 flex-wrap items-center gap-3 rounded-2xl px-4 py-2.5">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4" style={{ color: enabled && running ? '#3b82f6' : 'var(--neu-ink-soft)' }} />
        <span className="text-[13px] font-bold" style={{ color: 'var(--neu-ink)' }}>自动执行</span>
      </div>

      {/* 网关连接状态（真实） */}
      <span className="flex items-center gap-1 text-[11px]" style={{ color: connColor }}>
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: connColor }} />
        {connLabel}
      </span>

      {/* 运行说明 */}
      <span className="flex min-w-0 items-center gap-1 text-[11px]" style={{ color: 'var(--neu-ink-soft)' }}>
        {enabled && running && <Loader2 className="h-3 w-3 animate-spin" style={{ color: '#3b82f6' }} />}
        <span className="truncate">{note}</span>
      </span>

      {enabled && (
        <span className="text-[11px] tabular-nums" style={{ color: 'var(--neu-ink-soft)' }}>
          执行中 {activeCount} · 已处理 {processed}
        </span>
      )}

      {/* 并发度调节 */}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px]" style={{ color: 'var(--neu-ink-soft)' }}>并发</span>
        <button
          type="button"
          onClick={() => setConcurrency(concurrency - 1)}
          disabled={concurrency <= 1}
          className="neu-btn flex h-6 w-6 items-center justify-center rounded-md text-[13px] font-bold disabled:opacity-40"
          style={{ color: 'var(--neu-ink)' }}
          aria-label="减少并发"
        >
          −
        </button>
        <span className="w-4 text-center text-[12px] font-bold tabular-nums" style={{ color: 'var(--neu-ink)' }}>
          {concurrency}
        </span>
        <button
          type="button"
          onClick={() => setConcurrency(concurrency + 1)}
          disabled={concurrency >= 8}
          className="neu-btn flex h-6 w-6 items-center justify-center rounded-md text-[13px] font-bold disabled:opacity-40"
          style={{ color: 'var(--neu-ink)' }}
          aria-label="增加并发"
        >
          +
        </button>
      </div>

      {/* 开关 */}
      <button
        type="button"
        onClick={() => (enabled ? disable() : enable())}
        className="neu-btn ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold"
        style={{ color: enabled ? '#ef4444' : '#22c55e' }}
      >
        {enabled ? <PowerOff className="h-3.5 w-3.5" /> : <PlugZap className="h-3.5 w-3.5" />}
        {enabled ? '关闭自动' : '开启自动'}
      </button>
    </div>
  );
}
