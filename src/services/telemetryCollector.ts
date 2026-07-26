/**
 * src/services/telemetryCollector.ts
 * 运行期遥测采集（T05）。
 *
 * 读取 ClawCorp 转录文件（~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl），
 * 复用 token-usage-core 的 parseUsageEntriesFromJsonl / extractSessionIdFromTranscriptFileName
 * 解析用量行，派生符合 src/types/evaluation.ts 的 TelemetryEvent[]。
 *
 * 防御性：转录缺失或解析为空时，从真实 token 用量（getRecentTokenUsageHistory）
 * 回退派生最小遥测，保证 ROI / KPI 管线不中断。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, readdir, access } from 'node:fs/promises';

import { getRecentTokenUsageHistory } from '@electron/utils/token-usage';
import {
  parseUsageEntriesFromJsonl,
  extractSessionIdFromTranscriptFileName,
} from '@electron/utils/token-usage-core';
import type { TelemetryEvent } from '@/types/evaluation';

/** OpenClaw 转录根目录：~/.openclaw/agents */
const OPENCLAW_AGENTS_DIR = join(homedir(), '.openclaw', 'agents');

/**
 * 解析某 agent 的转录路径：优先按 sessions 目录内的文件名匹配 sessionId
 * （extractSessionIdFromTranscriptFileName 容忍 .reset / .deleted 后缀），
 * 回退到 <sessionId>.jsonl 直接路径。
 */
async function resolveTranscriptPath(
  agentId: string,
  sessionId: string,
): Promise<string | null> {
  const sessionsDir = join(OPENCLAW_AGENTS_DIR, agentId, 'sessions');
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
  const path = await resolveTranscriptPath(agentId, sessionId);
  if (!path) return '';
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/** 转录缺失时的回退：从真实 token 用量派生最小遥测 */
function telemetryFromUsage(agentId: string, sessionId: string): Promise<TelemetryEvent[]> {
  return getRecentTokenUsageHistory(2000).then((entries) =>
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
  const path = await resolveTranscriptPath(agentId, sessionId);
  let raw = '';
  if (path) {
    try {
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
