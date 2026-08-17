/**
 * electron/utils/deliverables.ts
 * 任务交付文件落盘：把编排产出的文件列表写到
 * ~/.openclaw/deliverables/<taskId>/，返回目录与已保存文件名。
 *
 * 安全约束：文件名只保留安全字符（防路径穿越），单文件最大 1MB，
 * 单次最多 50 个文件。写入失败如实抛错，由调用方降级处理。
 */
import { execFile } from 'child_process';
import { mkdir, readdir, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { getOpenClawConfigDir } from './paths';

const execFileAsync = promisify(execFile);

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

  // 每轮交付都是「当前最新全量」：先清掉上一轮的旧文件，
  // 否则旧 HTML 残留，「在浏览器打开」/ZIP 打包会拿到历史版本。
  const stale = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(stale.map((name) => unlink(join(dir, name)).catch(() => {})));

  const saved: string[] = [];
  for (const f of files.slice(0, MAX_FILES)) {
    if (!f || typeof f.content !== 'string') continue;
    const name = sanitizeFileName(f.name);
    await writeFile(join(dir, name), f.content.slice(0, MAX_FILE_BYTES), 'utf8');
    saved.push(name);
  }
  return { dir, saved };
}

/**
 * 找某个任务交付目录里的 HTML 文件（可直接在浏览器运行的交付物）。
 * 优先 index.html（多文件网站入口），否则取排序后的第一个 HTML。
 * 返回完整路径；没有 HTML 或目录不存在时返回 null。
 */
export async function findHtmlDeliverable(taskId: string): Promise<string | null> {
  const safeTaskId = sanitizeFileName(taskId);
  const dir = join(getOpenClawConfigDir(), 'deliverables', safeTaskId);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const htmls = entries.filter((name) => /\.html?$/i.test(name)).sort();
  const pick = htmls.find((name) => /^index\.html?$/i.test(name)) ?? htmls[0];
  return pick ? join(dir, pick) : null;
}

/**
 * 列出任务交付目录里的文件名（供看板逐文件打开/预览）。
 * 目录不存在时返回空数组。
 */
export async function listTaskDeliverables(taskId: string): Promise<string[]> {
  const safeTaskId = sanitizeFileName(taskId);
  const dir = join(getOpenClawConfigDir(), 'deliverables', safeTaskId);
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.sort();
}

/**
 * 把某个任务的交付目录打包成 zip，放在 ~/.openclaw/deliverables/<taskId>.zip。
 * 不引入第三方依赖：macOS 用 ditto，Windows 用 PowerShell Compress-Archive，
 * 其他平台用 zip -r。目录不存在或为空时如实抛错。
 */
export async function zipTaskDeliverables(taskId: string): Promise<{ zipPath: string }> {
  const safeTaskId = sanitizeFileName(taskId);
  const baseDir = join(getOpenClawConfigDir(), 'deliverables');
  const dir = join(baseDir, safeTaskId);
  const entries = await readdir(dir).catch(() => {
    throw new Error(`交付目录不存在：${dir}`);
  });
  if (entries.length === 0) throw new Error(`交付目录为空：${dir}`);

  const zipPath = join(baseDir, `${safeTaskId}.zip`);
  if (process.platform === 'darwin') {
    await execFileAsync('ditto', ['-c', '-k', '--norsrc', dir, zipPath]);
  } else if (process.platform === 'win32') {
    await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path '${dir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ]);
  } else {
    await execFileAsync('zip', ['-r', zipPath, '.'], { cwd: dir });
  }
  return { zipPath };
}
