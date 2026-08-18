/**
 * electron/utils/member-stats.ts
 * 成员绩效统计持久化（D：DyLAN 贡献度思想，arXiv:2310.02170）。
 *
 * DyLAN 按各 agent 在协作中的实际贡献动态评估其重要性；这里把「贡献度」
 * 落地为逐子任务累积的 {tasks, passed, totalRounds}：每次多成员编排结束后，
 * 渲染层把 SubTaskResult 归集成 outcome 逐条上报，本模块增量更新
 * member-stats.json。渲染层再投影成 {tasks, approvedRate, avgRounds}
 * （toPerformance，见 src/types/performance.ts）注入路由候选。
 *
 * 持久化风格与 schedule-config.ts / task-config.ts 一致：
 * withConfigLock 串行化读-改-写 + tmp+rename 原子写 + 损坏备份后抛错
 * （绝不静默以空文档覆盖残留数据）。
 */
import { constants } from 'fs';
import { access, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import { withConfigLock } from './config-mutex';
import { getOpenClawConfigDir } from './paths';
import { logger } from './logger';
import type { MemberStats } from '../../src/types/performance';

interface MemberStatsDocument {
  members?: Record<string, MemberStats>;
}

const MEMBER_STATS_FILE = join(getOpenClawConfigDir(), 'member-stats.json');
const MEMBER_STATS_TMP_FILE = `${MEMBER_STATS_FILE}.tmp`;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureConfigDir(): Promise<void> {
  await mkdir(getOpenClawConfigDir(), { recursive: true });
}

/**
 * 把损坏的配置文件 rename 成 `<file>.corrupt-<时间戳>` 备份，
 * 避免后续写操作以「空文档」为基准把残留数据盖掉。
 * 返回备份路径；备份失败返回 null（原文件保持不动）。
 */
async function backupCorruptFile(filePath: string): Promise<string | null> {
  const backupPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    await rename(filePath, backupPath);
    return backupPath;
  } catch (backupError) {
    logger.error(`Failed to back up corrupt config file: ${filePath}`, backupError);
    return null;
  }
}

async function readMemberStatsDocument(): Promise<MemberStatsDocument> {
  await ensureConfigDir();
  if (!(await fileExists(MEMBER_STATS_FILE))) {
    return { members: {} };
  }

  try {
    const content = await readFile(MEMBER_STATS_FILE, 'utf8');
    return JSON.parse(content) as MemberStatsDocument;
  } catch (error) {
    // 解析失败绝不能返回空文档——那会让下一次写操作以空文档为基准
    // 读-改-写，把全部成员统计永久覆盖掉。备份坏文件后抛错，由调用方降级（HTTP 500）。
    const backupPath = await backupCorruptFile(MEMBER_STATS_FILE);
    logger.error('Failed to read member stats', error);
    throw new Error(
      `Member stats config is corrupted (backed up to ${backupPath ?? 'unavailable'}): ${MEMBER_STATS_FILE}`,
      { cause: error },
    );
  }
}

async function writeMemberStatsDocument(document: MemberStatsDocument): Promise<void> {
  await ensureConfigDir();
  // 原子写：先写 tmp 再 rename，避免崩溃截断留下半个 JSON
  await writeFile(MEMBER_STATS_TMP_FILE, JSON.stringify({ members: document.members ?? {} }, null, 2), 'utf8');
  await rename(MEMBER_STATS_TMP_FILE, MEMBER_STATS_FILE);
}

/** 全量快照：agentId → 累计绩效。 */
export async function getMemberStats(): Promise<Record<string, MemberStats>> {
  const document = await readMemberStatsDocument();
  return document.members ?? {};
}

/**
 * 增量记录一条子任务结果：tasks+1，approved 则 passed+1，totalRounds+rounds。
 * 返回更新后的全量快照（路由直接回给渲染层同步 store）。
 */
export async function recordMemberOutcome(
  agentId: string,
  outcome: { approved: boolean; rounds: number },
): Promise<Record<string, MemberStats>> {
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('agentId is required');
  }
  if (!Number.isFinite(outcome.rounds) || outcome.rounds < 0) {
    throw new Error(`Invalid rounds: ${outcome.rounds}`);
  }

  return withConfigLock(async () => {
    const document = await readMemberStatsDocument();
    const members = { ...(document.members ?? {}) };
    const prev = members[agentId] ?? { tasks: 0, passed: 0, totalRounds: 0, updatedAt: '' };
    members[agentId] = {
      tasks: prev.tasks + 1,
      passed: prev.passed + (outcome.approved ? 1 : 0),
      totalRounds: prev.totalRounds + Math.round(outcome.rounds),
      updatedAt: new Date().toISOString(),
    };
    await writeMemberStatsDocument({ members });
    return members;
  });
}
