/**
 * electron/utils/llm-usage-log.ts
 * LLM token 用量日志持久化（成本看板数据源）。
 *
 * 存储：~/.openclaw/usage-log.json，{ entries: LlmUsageRecord[] }。
 * 写路径与 task-config.ts 同构：withConfigLock 串行化读-改-写 +
 * 先写 .tmp 再 rename 的原子写；解析损坏时 rename 备份成
 * usage-log.json.corrupt-<时间戳> 后抛错，绝不以空文档为基准覆盖残留数据。
 */
import { constants } from 'fs';
import { access, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import { withConfigLock } from './config-mutex';
import { getOpenClawConfigDir } from './paths';
import { logger } from './logger';
import type { LlmUsageRecord } from '../../src/types/llm-usage';

interface LlmUsageLogDocument {
  entries?: LlmUsageRecord[];
}

const USAGE_LOG_FILE = join(getOpenClawConfigDir(), 'usage-log.json');
const USAGE_LOG_TMP_FILE = `${USAGE_LOG_FILE}.tmp`;

/** 日志上限：超出时丢弃最旧记录，避免长期运行无限膨胀。 */
export const LLM_USAGE_MAX_ENTRIES = 5000;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function backupCorruptFile(filePath: string): Promise<string | null> {
  const backupPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    await rename(filePath, backupPath);
    return backupPath;
  } catch (backupError) {
    logger.error(`Failed to back up corrupt usage log: ${filePath}`, backupError);
    return null;
  }
}

async function readUsageDocument(): Promise<LlmUsageLogDocument> {
  await mkdir(getOpenClawConfigDir(), { recursive: true });
  if (!(await fileExists(USAGE_LOG_FILE))) {
    return { entries: [] };
  }
  try {
    const content = await readFile(USAGE_LOG_FILE, 'utf8');
    const parsed = JSON.parse(content) as LlmUsageLogDocument;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch (error) {
    // 与 task-config 同一语义：备份坏文件后抛错，由调用方降级（HTTP 500）。
    const backupPath = await backupCorruptFile(USAGE_LOG_FILE);
    logger.error('Failed to read LLM usage log', error);
    throw new Error(
      `LLM usage log is corrupted (backed up to ${backupPath ?? 'unavailable'}): ${USAGE_LOG_FILE}`,
      { cause: error },
    );
  }
}

async function writeUsageDocument(document: LlmUsageLogDocument): Promise<void> {
  await mkdir(getOpenClawConfigDir(), { recursive: true });
  // 原子写：先写 tmp 再 rename，避免崩溃截断留下半个 JSON
  await writeFile(USAGE_LOG_TMP_FILE, JSON.stringify({ entries: document.entries ?? [] }), 'utf8');
  await rename(USAGE_LOG_TMP_FILE, USAGE_LOG_FILE);
}

/** append 一批用量记录（withConfigLock 串行化，超出上限丢弃最旧）。 */
export async function appendLlmUsageRecords(
  records: LlmUsageRecord[],
  maxEntries: number = LLM_USAGE_MAX_ENTRIES,
): Promise<number> {
  if (records.length === 0) return 0;
  return withConfigLock(async () => {
    const document = await readUsageDocument();
    const entries = [...(document.entries ?? []), ...records];
    const trimmed = entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries;
    await writeUsageDocument({ entries: trimmed });
    return records.length;
  });
}

/** 全量读出（数据量小，由前端做时间过滤与聚合）。 */
export async function listLlmUsageRecords(): Promise<LlmUsageRecord[]> {
  const document = await readUsageDocument();
  return document.entries ?? [];
}
