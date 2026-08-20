/**
 * electron/services/experience/capsule-store.ts
 * 经验胶囊的落盘与读取（主进程）。
 *
 * 与 A2A trace 同落盘模式（~/.openclaw/ 下），但 capsule 量小且需全量检索，
 * 用单文件 append 更合适：~/.openclaw/capsules/capsules.jsonl（每行一颗 JSON）。
 *
 * 容错原则（与 a2a-trace.ts 同口径）：
 * - 落盘是观察者行为，任何失败都只吞掉，绝不阻塞交付主流程；
 * - 读盘失败返回 []，绝不抛出；
 * - 损坏行跳过，合法行仍返回。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getOpenClawConfigDir } from '../../utils/paths';
import type { ExperienceCapsule, CapsuleQuery } from '../../../src/types/capsule';
import { findSimilarCapsules } from '../../../src/engine/experience/capsule';

/** 胶囊落盘目录（~/.openclaw/capsules） */
export function getCapsulesDir(): string {
  return join(getOpenClawConfigDir(), 'capsules');
}

/** 胶囊落盘文件路径（单文件 append） */
function capsulesFilePath(dirOverride?: string): string {
  return join(dirOverride ?? getCapsulesDir(), 'capsules.jsonl');
}

/** 追加一颗胶囊到 jsonl。best-effort，失败吞掉不抛出。 */
export async function appendCapsule(
  capsule: ExperienceCapsule,
  dirOverride?: string,
): Promise<boolean> {
  try {
    const dir = dirOverride ?? getCapsulesDir();
    await mkdir(dir, { recursive: true });
    const line = `${JSON.stringify(capsule)}\n`;
    await appendFile(capsulesFilePath(dirOverride), line, 'utf8');
    return true;
  } catch {
    // 评测回流是观察者：它自己出问题，不能反过来影响已经交付的工作
    return false;
  }
}

/** 读取全部胶囊（按 createdAt 升序）。文件缺失/损坏时返回 []，永不抛出。 */
export async function readAllCapsules(
  dirOverride?: string,
): Promise<ExperienceCapsule[]> {
  try {
    const raw = await readFile(capsulesFilePath(dirOverride), 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as ExperienceCapsule;
        } catch {
          return null;
        }
      })
      .filter((c): c is ExperienceCapsule => c != null)
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  } catch {
    return [];
  }
}

/** 按条件列出胶囊（复用渲染层纯函数 findSimilarCapsules）。 */
export async function listCapsules(
  query?: CapsuleQuery,
  dirOverride?: string,
): Promise<ExperienceCapsule[]> {
  const all = await readAllCapsules(dirOverride);
  if (!query) return all;
  return findSimilarCapsules(all, query);
}

/** 胶囊总数（供健康检查/仪表盘用）。 */
export async function countCapsules(dirOverride?: string): Promise<number> {
  const all = await readAllCapsules(dirOverride);
  return all.length;
}
