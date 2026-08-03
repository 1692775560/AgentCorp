/**
 * src/services/telemetryCollector.ts
 * 运行期遥测采集（T05）。
 *
 * 读取 AgentCorp 转录文件（~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl），
 * 复用 token-usage-core 的 parseUsageEntriesFromJsonl / extractSessionIdFromTranscriptFileName
 * 解析用量行，派生符合 src/types/evaluation.ts 的 TelemetryEvent[]。
 *
 * 防御性：转录缺失或解析为空时，从真实 token 用量（getRecentTokenUsageHistory）
 * 回退派生最小遥测，保证 ROI / KPI 管线不中断。
 *
 * ⚠️ 浏览器预览（web 预览版）环境没有真实文件系统 / 转录目录，且 node:fs 不可在
 * 浏览器中静态引入（否则会触发 "Dynamic require of fs/promises"）。因此本模块：
 *   1. 不再在文件顶层静态 import node:fs / node:os / node:path / @electron/utils/token-usage；
 *   2. 所有 Node-only 逻辑改为运行时「动态 import」并在「浏览器守卫」下短路返回安全空值。
 * 这样市集 / 面试 / 评估等页面在 web 预览里可以正常加载，遥测仅在有 Node 运行时的
 * Electron 桌面端真正生效（前端与后端能力解耦）。
 */
import type { TelemetryEvent } from '@/types/evaluation';
import {
  parseUsageEntriesFromJsonl,
  extractSessionIdFromTranscriptFileName,
} from '@electron/utils/token-usage-core';

/**
 * 浏览器预览环境识别：web 预览版会在 window.electron 上挂
 * __agentcorpBrowserPreviewShim 标志（见 vite.web.config.ts 注入的 shim）。
 * 仅有该标志时视为「无文件系统的浏览器预览」，遥测安全降级。
 */
const IS_BROWSER_PREVIEW =
  typeof window !== 'undefined' &&
  (
    window as unknown as {
      electron?: { __agentcorpBrowserPreviewShim?: boolean };
    }
  ).electron?.__agentcorpBrowserPreviewShim === true;

/** OpenClaw 转录根目录：~/.openclaw/agents（仅 Electron 运行时可用） */
async function openclawAgentsDir(): Promise<string> {
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  return join(homedir(), '.openclaw', 'agents');
}

/**
 * 解析某 agent 的转录路径：优先按 sessions 目录内的文件名匹配 sessionId
 * （extractSessionIdFromTranscriptFileName 容忍 .reset / .deleted 后缀），
 * 回退到 <sessionId>.jsonl 直接路径。
 */
async function resolveTranscriptPath(
  agentId: string,
  sessionId: string,
): Promise<string | null> {
  if (IS_BROWSER_PREVIEW) return null;
  const { readdir, access } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const sessionsDir = join(await openclawAgentsDir(), agentId, 'sessions');
  try {
    const files = await readdir(sessionsDir);
    for (const fileName of files) {
      if (extractSessionIdFromTranscriptFileName(fileName) === sessionId) {
        return join(sessionsDir, fileName);
      }
    }
  } catch {
    // 目录不可读：走直接回退路径
  }
  const direct = join(sessionsDir, `${sessionId}.jsonl`);
  try {
    await access(direct);
    return direct;
  } catch {
    return null;
  }
}

/** 读取转录原始文本（缺失返回空串） */
export async function readTranscript(
  _sessionKey: string,
  sessionId: string,
  agentId: string,
): Promise<string> {
  if (IS_BROWSER_PREVIEW) return '';
  const path = await resolveTranscriptPath(agentId, sessionId);
  if (!path) return '';
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/** 转录缺失时的回退：从真实 token 用量派生最小遥测 */
function telemetryFromUsage(agentId: string, sessionId: string): Promise<TelemetryEvent[]> {
  if (IS_BROWSER_PREVIEW) return Promise.resolve([]);
  return import('@electron/utils/token-usage').then(({ getRecentTokenUsageHistory }) =>
    getRecentTokenUsageHistory(2000).then((entries) =>
      entries
        .filter((e) => e.agentId === agentId || e.sessionId === sessionId)
        .map<TelemetryEvent>((e) => ({
          agent_id: agentId,
          task_id: sessionId,
          success: true,
          first_try: true,
          rework: 0,
          latency_ms: 0,
          human_interventions: 0,
          escalations: 0,
          out_of_domain: false,
          ts: e.timestamp,
        })),
    ),
  );
}

/**
 * 采集某次运行（session）的遥测事件。
 * @returns TelemetryEvent[]（best-effort：成功=有用量记录；时延=首尾时间戳差；其余保守为 0/false）
 */
export async function collect(
  _sessionKey: string,
  sessionId: string,
  agentId: string,
): Promise<TelemetryEvent[]> {
  if (IS_BROWSER_PREVIEW) return [];
  const path = await resolveTranscriptPath(agentId, sessionId);
  let raw = '';
  if (path) {
    try {
      const { readFile } = await import('node:fs/promises');
      raw = await readFile(path, 'utf8');
    } catch {
      raw = '';
    }
  }

  if (!raw.trim()) {
    return telemetryFromUsage(agentId, sessionId);
  }

  const usageEntries = parseUsageEntriesFromJsonl(raw, { sessionId, agentId });
  if (usageEntries.length === 0) {
    return telemetryFromUsage(agentId, sessionId);
  }

  const timestamps = usageEntries
    .map((e) => Date.parse(e.timestamp))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  const latencyMs =
    timestamps.length >= 2 ? timestamps[timestamps.length - 1] - timestamps[0] : 0;
  const completed = usageEntries.length;

  return [
    {
      agent_id: agentId,
      task_id: sessionId,
      success: true, // 存在用量记录即视为运行完成
      first_try: completed <= 1,
      rework: 0,
      latency_ms: latencyMs,
      human_interventions: 0,
      escalations: 0,
      out_of_domain: false,
      ts: usageEntries[usageEntries.length - 1]?.timestamp ?? new Date().toISOString(),
    },
  ];
}

/** 聚合导出（供 evaluation store 按约定名编排） */
export const telemetryCollector = {
  collect,
  readTranscript,
};
