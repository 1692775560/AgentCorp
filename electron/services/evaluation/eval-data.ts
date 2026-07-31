/**
 * electron/services/evaluation/eval-data.ts
 * 评估运行数据采集（主进程）。
 *
 * 从渲染层迁入（原 src/services/telemetryCollector.ts / tokenUsageCollector.ts 的
 * collect* 部分）：渲染进程无文件系统能力，转录读取与用量扫描必须在主进程完成。
 *
 * 数据源：
 * - 转录：~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
 * - 用量：getRecentTokenUsageHistory（electron/utils/token-usage）
 * - 会话清单：sessions 目录下的 sessions.json（容忍三种 shape）+ 文件名扫描兜底
 */
import { readdir, readFile, access, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { getOpenClawConfigDir } from '../../utils/paths';
import { getRecentTokenUsageHistory } from '../../utils/token-usage';
import {
  extractSessionIdFromTranscriptFileName,
  parseUsageEntriesFromJsonl,
  type TokenUsageHistoryEntry,
} from '../../utils/token-usage-core';
import type { TelemetryEvent } from '../../../src/types/evaluation';

/** 会话下拉框选项（评估页用） */
export interface AgentSessionOption {
  /** 完整 sessionKey（agent:<agentId>:<suffix>）；扫描兜底时可能缺失 */
  sessionKey: string;
  /** 转录文件名对应的 session UUID */
  sessionId: string;
  /** 最后更新时间（ISO）；未知为空串 */
  updatedAt: string;
}

/** collectRunData 返回包 */
export interface RunData {
  events: TelemetryEvent[];
  transcript: string;
  entries: TokenUsageHistoryEntry[];
}

/** agentId 防路径穿越（与 session:delete 同级防护） */
function assertValidAgentId(agentId: string): void {
  if (!agentId || agentId.includes('/') || agentId.includes('\\') || agentId.includes('..')) {
    throw new Error(`Invalid agentId: ${agentId}`);
  }
}

function sessionsDirOf(agentId: string): string {
  assertValidAgentId(agentId);
  return join(getOpenClawConfigDir(), 'agents', agentId, 'sessions');
}

/**
 * sessions.json 的 updatedAt 在 OpenClaw Gateway 实际数据里是 epoch 毫秒数字，
 * 也容忍 ISO 字符串；其余一律归一为空串（未知）。
 */
function normalizeUpdatedAt(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return new Date(raw).toISOString();
  }
  return '';
}

/**
 * 解析 sessions.json，容忍 OpenClaw Gateway 的三种 shape：
 *   A: { sessions: [{ key|sessionKey, file|fileName|path|id, updatedAt? }] }
 *   B: { [sessionKey]: { sessionFile|file|fileName|path|sessionId|id, updatedAt? } }
 *   C: { [sessionKey]: "<fileName>" }
 */
function parseSessionsJson(
  sessionsJson: Record<string, unknown>,
): AgentSessionOption[] {
  const options: AgentSessionOption[] = [];

  const push = (sessionKey: string, entry: Record<string, unknown>) => {
    const fileRef = (entry.sessionFile ?? entry.file ?? entry.fileName ?? entry.path) as
      | string
      | undefined;
    let sessionId: string | undefined;
    if (fileRef) {
      sessionId = extractSessionIdFromTranscriptFileName(fileRef.split('/').pop() ?? fileRef);
    }
    if (!sessionId) {
      sessionId = (entry.sessionId ?? entry.id) as string | undefined;
    }
    if (!sessionId) return;
    options.push({
      sessionKey,
      sessionId,
      updatedAt: normalizeUpdatedAt(entry.updatedAt),
    });
  };

  // Shape A —— 数组 under "sessions"
  if (Array.isArray(sessionsJson.sessions)) {
    for (const item of sessionsJson.sessions as Array<Record<string, unknown>>) {
      const key = (item.key ?? item.sessionKey) as string | undefined;
      if (key) push(key, item);
    }
    return options;
  }

  // Shape B / C —— 扁平对象 keyed by sessionKey
  for (const [key, value] of Object.entries(sessionsJson)) {
    if (typeof value === 'string') {
      const sessionId = extractSessionIdFromTranscriptFileName(value);
      if (sessionId) options.push({ sessionKey: key, sessionId, updatedAt: '' });
    } else if (value && typeof value === 'object') {
      push(key, value as Record<string, unknown>);
    }
  }
  return options;
}

/**
 * 列出 agent 的真实会话（评估页下拉框数据源）。
 * 优先 sessions.json；读不到或解析为空时回退扫描 sessions 目录的 *.jsonl 文件
 * （排除 .deleted.），sessionKey 按 `agent:<agentId>:<sessionId>` 重建。
 * 结果按 updatedAt / 文件 mtime 降序。
 */
export async function listAgentSessions(agentId: string): Promise<AgentSessionOption[]> {
  const sessionsDir = sessionsDirOf(agentId);

  // 1) sessions.json
  try {
    const raw = await readFile(join(sessionsDir, 'sessions.json'), 'utf8');
    const options = parseSessionsJson(JSON.parse(raw) as Record<string, unknown>);
    if (options.length > 0) {
      return options.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
  } catch {
    // sessions.json 缺失/损坏：走文件名扫描兜底
  }

  // 2) 文件名扫描兜底
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const options: AgentSessionOption[] = [];
  for (const fileName of files) {
    if (!fileName.endsWith('.jsonl') || fileName.includes('.deleted.')) continue;
    const sessionId = extractSessionIdFromTranscriptFileName(fileName);
    if (!sessionId) continue;
    let updatedAt = '';
    try {
      updatedAt = (await stat(join(sessionsDir, fileName))).mtime.toISOString();
    } catch {
      // mtime 不可得时留空
    }
    options.push({
      sessionKey: `agent:${agentId}:${sessionId}`,
      sessionId,
      updatedAt,
    });
  }
  return options.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 解析转录路径：先按文件名提取的 sessionId 匹配，回退 <sessionId>.jsonl 直接路径 */
async function resolveTranscriptPath(agentId: string, sessionId: string): Promise<string | null> {
  const sessionsDir = sessionsDirOf(agentId);
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

/** 转录缺失时的回退：从真实 token 用量派生最小遥测 */
async function telemetryFromUsage(
  agentId: string,
  sessionId: string,
): Promise<TelemetryEvent[]> {
  const entries = await getRecentTokenUsageHistory(2000);
  return entries
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
    }));
}

/**
 * 采集某次运行的全部评估数据（一次读盘，供 ROI / KPI / judge 三处消费）。
 * 行为与渲染层旧实现一致：转录缺失或解析为空时回退 usage 派生最小遥测。
 * agentId 与 sessionId 至少提供一个；agentId 缺省时仅按 session 过滤用量。
 */
export async function collectRunData(
  agentId: string,
  sessionId: string,
): Promise<RunData> {
  if (agentId) {
    assertValidAgentId(agentId);
  } else if (!sessionId) {
    throw new Error('collectRunData: agentId 与 sessionId 至少提供一个');
  }

  // 1) token 用量（按 session 优先，回退 agent）
  let entries = (await getRecentTokenUsageHistory(2000)).filter(
    (e) => e.sessionId === sessionId,
  );
  if (entries.length === 0 && agentId) {
    entries = (await getRecentTokenUsageHistory(2000)).filter((e) => e.agentId === agentId);
  }

  // 2) 转录
  let transcript = '';
  if (agentId && sessionId) {
    const path = await resolveTranscriptPath(agentId, sessionId);
    if (path) {
      try {
        transcript = await readFile(path, 'utf8');
      } catch {
        transcript = '';
      }
    }
  }

  // 3) 遥测事件
  let events: TelemetryEvent[];
  if (!transcript.trim()) {
    events = await telemetryFromUsage(agentId, sessionId);
  } else {
    const usageEntries = parseUsageEntriesFromJsonl(transcript, { sessionId, agentId });
    if (usageEntries.length === 0) {
      events = await telemetryFromUsage(agentId, sessionId);
    } else {
      const timestamps = usageEntries
        .map((e) => Date.parse(e.timestamp))
        .filter((t) => !Number.isNaN(t))
        .sort((a, b) => a - b);
      const latencyMs =
        timestamps.length >= 2 ? timestamps[timestamps.length - 1] - timestamps[0] : 0;
      events = [
        {
          agent_id: agentId,
          task_id: sessionId,
          success: true, // 存在用量记录即视为运行完成
          first_try: usageEntries.length <= 1,
          rework: 0,
          latency_ms: latencyMs,
          human_interventions: 0,
          escalations: 0,
          out_of_domain: false,
          ts: usageEntries[usageEntries.length - 1]?.timestamp ?? new Date().toISOString(),
        },
      ];
    }
  }

  return { events, transcript, entries };
}
