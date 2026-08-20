/**
 * electron/utils/path-whitelist.ts
 * shell:openPath / shell:showItemInFolder 的路径白名单。
 *
 * 背景：这两个通道此前零校验，渲染进程可让主进程 open() 任意路径——
 * macOS 上 open 一个 .command / .app 等于执行它；而 agent 产出的 markdown
 * 里「看起来像本地路径」的文本会被渲染成可点链接（MarkdownContent），
 * 即「间接 prompt 注入 → 诱导用户点链接 → 本地命令执行」。
 *
 * 策略：只允许打开明确属于本应用的根目录子树——
 *   1. OpenClaw 配置目录（~/.openclaw：deliverables、media/outbound 附件等）
 *   2. Electron userData 目录（应用日志等）
 * resolve 后做前缀断言，符号链接之外的「..」穿越一律拒绝。
 */
import { resolve, sep } from 'node:path';

/** 计算允许打开的根目录（resolve 规范化后的绝对路径）。 */
export function allowedOpenRoots(configDir: string, userDataDir: string): string[] {
  return [resolve(configDir), resolve(userDataDir)];
}

/** target 是否落在任一允许根目录内（含根目录本身）。非字符串/空串一律拒绝。 */
export function isPathAllowed(target: unknown, roots: readonly string[]): boolean {
  if (typeof target !== 'string' || !target.trim()) return false;
  const resolved = resolve(target);
  return roots.some((root) => resolved === root || resolved.startsWith(root + sep));
}

/** 拒绝时的统一错误文案（shell.openPath 约定返回错误字符串，空串为成功）。 */
export const OPEN_PATH_DENIED = '路径不在允许打开的范围内（仅限应用交付/日志目录）';
