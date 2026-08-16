/**
 * electron/utils/deliverables.ts
 * 任务交付文件落盘：把编排产出的文件列表写到
 * ~/.openclaw/deliverables/<taskId>/，返回目录与已保存文件名。
 *
 * 安全约束：文件名只保留安全字符（防路径穿越），单文件最大 1MB，
 * 单次最多 50 个文件。写入失败如实抛错，由调用方降级处理。
 */
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { getOpenClawConfigDir } from './paths';

export interface DeliverableFileInput {
  name: string;
  content: string;
}

export interface SaveDeliverablesResult {
  dir: string;
  saved: string[];
}

const MAX_FILES = 50;
const MAX_FILE_BYTES = 1_000_000;

/** 只保留安全文件名字符；空结果回退 untitled。 */
function sanitizeFileName(name: string): string {
  const base = name.split('/').pop() ?? name;
  const cleaned = base.replace(/[^\w一-龥.-]/g, '_').slice(0, 80);
  return cleaned || 'untitled.md';
}

export async function saveTaskDeliverables(
  taskId: string,
  files: DeliverableFileInput[],
): Promise<SaveDeliverablesResult> {
  const safeTaskId = sanitizeFileName(taskId);
  const dir = join(getOpenClawConfigDir(), 'deliverables', safeTaskId);
  await mkdir(dir, { recursive: true });

  const saved: string[] = [];
  for (const f of files.slice(0, MAX_FILES)) {
    if (!f || typeof f.content !== 'string') continue;
    const name = sanitizeFileName(f.name);
    await writeFile(join(dir, name), f.content.slice(0, MAX_FILE_BYTES), 'utf8');
    saved.push(name);
  }
  return { dir, saved };
}
