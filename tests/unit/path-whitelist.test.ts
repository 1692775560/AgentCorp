/**
 * tests/unit/path-whitelist.test.ts
 * shell:openPath / showItemInFolder 的路径白名单（path-whitelist.ts）：
 * 只允许打开应用自有目录子树（~/.openclaw 交付/附件、userData 日志），
 * 防「agent 输出的链接诱导用户点开 .command/.app → 本地命令执行」。
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import { allowedOpenRoots, isPathAllowed } from '../../electron/utils/path-whitelist';

const configDir = join(homedir(), '.openclaw');
const userData = join(homedir(), 'Library', 'Application Support', 'agentcorp');
const roots = allowedOpenRoots(configDir, userData);

describe('isPathAllowed', () => {
  it('交付目录与附件目录 → 允许', () => {
    expect(isPathAllowed(join(configDir, 'deliverables', 'task-1', 'index.html'), roots)).toBe(true);
    expect(isPathAllowed(join(configDir, 'media', 'outbound', 'pic.png'), roots)).toBe(true);
    expect(isPathAllowed(join(userData, 'logs', 'app.log'), roots)).toBe(true);
    // 根目录本身也允许（打开交付根目录）
    expect(isPathAllowed(configDir, roots)).toBe(true);
  });

  it('系统路径与家目录其他位置 → 拒绝', () => {
    expect(isPathAllowed('/etc/passwd', roots)).toBe(false);
    expect(isPathAllowed('/Applications/Safari.app', roots)).toBe(false);
    expect(isPathAllowed(join(homedir(), 'Desktop', 'evil.command'), roots)).toBe(false);
    expect(isPathAllowed(join(homedir(), '.ssh', 'id_rsa'), roots)).toBe(false);
  });

  it('.. 穿越逃出白名单 → 拒绝', () => {
    expect(isPathAllowed(join(configDir, '..', '.ssh', 'id_rsa'), roots)).toBe(false);
    expect(isPathAllowed(join(configDir, 'deliverables', '..', '..', 'etc', 'passwd'), roots)).toBe(false);
  });

  it('前缀撞名目录不算在白名单内（~/.openclaw-evil ≠ ~/.openclaw）', () => {
    expect(isPathAllowed(`${configDir}-evil/x.command`, roots)).toBe(false);
  });

  it('非字符串/空串 → 拒绝', () => {
    expect(isPathAllowed('', roots)).toBe(false);
    expect(isPathAllowed('   ', roots)).toBe(false);
    expect(isPathAllowed(undefined, roots)).toBe(false);
    expect(isPathAllowed(123, roots)).toBe(false);
  });
});
