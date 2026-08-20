/**
 * src/lib/a2a-trace-persist.ts
 * 渲染层 A2A trace 落盘桥。
 *
 * 团队任务编排（src/engine/squad/squadOrchestration.ts）在渲染层产出的
 * A2aTraceRecord 此前只转成看板时间线事件与房间广播，不落盘；
 * 本模块把它经 `POST /api/traces` 追加到主进程
 * ~/.openclaw/a2a-traces/<rootSessionId>.jsonl——
 * 与主进程委派链（session-runtime-manager → appendA2aTrace）同盘同源，
 * Trace 浏览面板（TraceBrowserPanel / GET /api/traces）因此天然覆盖
 * 团队任务协作轨迹，可按 taskId 过滤回看「这个团队为什么这么分工/谁审的谁」。
 *
 * 旁路证据原则：任何失败（web 预览无主进程、主进程不可达、落盘失败）
 * 一律静默，绝不影响编排主流程。
 */
import { hostApiFetch } from '@/lib/host-api';
import type { A2aTraceRecord } from '@/types/evaluation';

/** 追加落盘一条 A2A trace（fire-and-forget，失败静默）。 */
export function persistA2aTrace(record: A2aTraceRecord): void {
  void hostApiFetch('/api/traces', {
    method: 'POST',
    body: JSON.stringify({ records: [record] }),
  }).catch(() => {
    /* trace 是旁路证据：落盘失败不影响编排 */
  });
}
