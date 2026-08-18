/**
 * electron/utils/team-experience.ts
 * 团队经验卡持久化（F：Reflexion 式团队记忆）。
 *
 * Reflexion（arXiv:2303.11366）把任务后的语言化反思写入情景记忆、下次任务
 * 取回复用；MetaGPT（arXiv:2308.00352）的经验复用段落同样把历史经验作为
 * 资产注入后续协作。本模块是其存储层：每团队一个经验卡列表（封顶
 * MAX_EXPERIENCE_CARDS_PER_TEAM 条，append 裁最旧），持久化到
 * team-experience.json。
 *
 * 持久化风格与 schedule-config.ts / task-config.ts 一致：
 * withConfigLock 串行化读-改-写 + tmp+rename 原子写 + 损坏备份后抛错。
 */
import { constants } from 'fs';
import { access, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { withConfigLock } from './config-mutex';
import { getOpenClawConfigDir } from './paths';
import { logger } from './logger';
import type { ExperienceCard } from '../../src/types/experience';

/** 每团队经验卡上限：超出后 append 裁掉最旧（经验会过时，保留近期更重要）。 */
export const MAX_EXPERIENCE_CARDS_PER_TEAM = 20;

interface TeamExperienceDocument {
  teams?: Record<string, ExperienceCard[]>;
}

const TEAM_EXPERIENCE_FILE = join(getOpenClawConfigDir(), 'team-experience.json');
const TEAM_EXPERIENCE_TMP_FILE = `${TEAM_EXPERIENCE_FILE}.tmp`;

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

async function readTeamExperienceDocument(): Promise<TeamExperienceDocument> {
  await ensureConfigDir();
  if (!(await fileExists(TEAM_EXPERIENCE_FILE))) {
    return { teams: {} };
  }

  try {
    const content = await readFile(TEAM_EXPERIENCE_FILE, 'utf8');
    return JSON.parse(content) as TeamExperienceDocument;
  } catch (error) {
    // 解析失败绝不能返回空文档——那会让下一次写操作以空文档为基准
    // 读-改-写，把全部团队经验卡永久覆盖掉。备份坏文件后抛错，由调用方降级（HTTP 500）。
    const backupPath = await backupCorruptFile(TEAM_EXPERIENCE_FILE);
    logger.error('Failed to read team experience', error);
    throw new Error(
      `Team experience config is corrupted (backed up to ${backupPath ?? 'unavailable'}): ${TEAM_EXPERIENCE_FILE}`,
      { cause: error },
    );
  }
}

async function writeTeamExperienceDocument(document: TeamExperienceDocument): Promise<void> {
  await ensureConfigDir();
  // 原子写：先写 tmp 再 rename，避免崩溃截断留下半个 JSON
  await writeFile(TEAM_EXPERIENCE_TMP_FILE, JSON.stringify({ teams: document.teams ?? {} }, null, 2), 'utf8');
  await rename(TEAM_EXPERIENCE_TMP_FILE, TEAM_EXPERIENCE_FILE);
}

/** 读取某团队的经验卡列表（时间升序，最新在尾）；无记录返回空数组。 */
export async function listTeamExperience(teamId: string): Promise<ExperienceCard[]> {
  const document = await readTeamExperienceDocument();
  return document.teams?.[teamId] ?? [];
}

/**
 * 追加一条经验卡（content 必填，source 记来源 taskId），每团队封顶
 * MAX_EXPERIENCE_CARDS_PER_TEAM 条（append 后裁最旧）。返回该团队最新卡片列表。
 */
export async function appendTeamExperience(
  teamId: string,
  input: { content: string; source?: string },
): Promise<ExperienceCard[]> {
  const content = input.content?.trim();
  if (!teamId) {
    throw new Error('teamId is required');
  }
  if (!content) {
    throw new Error('content is required');
  }

  return withConfigLock(async () => {
    const document = await readTeamExperienceDocument();
    const teams = { ...(document.teams ?? {}) };
    const card: ExperienceCard = {
      id: `exp-${randomUUID()}`,
      content,
      source: input.source ?? '',
      createdAt: new Date().toISOString(),
    };
    teams[teamId] = [...(teams[teamId] ?? []), card].slice(-MAX_EXPERIENCE_CARDS_PER_TEAM);
    await writeTeamExperienceDocument({ teams });
    return teams[teamId];
  });
}
