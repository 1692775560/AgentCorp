/**
 * electron/utils/approval-signing-key.ts
 * 审批签名密钥的生命周期（Electron 主进程专用）。
 *
 * 密钥生成一次后由 safeStorage 加密，落盘在 userData 目录
 * （~/.openclaw 之外——agent 可写目录里绝不能出现这把钥匙）。
 * safeStorage 不可用（无系统钥匙串）时返回 null：审批决策宁可
 * 以「未签名」状态落盘并在日志留痕，也不用明文密钥凑合。
 */
import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { logger } from './logger';

const KEY_FILE = 'approval-signing.key';

let cachedKey: Buffer | null | undefined;

export function getApprovalSigningKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      logger.warn('[approvals] safeStorage unavailable; decisions will be written unsigned');
      cachedKey = null;
      return cachedKey;
    }
    const keyPath = join(app.getPath('userData'), KEY_FILE);
    if (existsSync(keyPath)) {
      const encrypted = readFileSync(keyPath);
      cachedKey = Buffer.from(safeStorage.decryptString(encrypted), 'hex');
      return cachedKey;
    }
    const fresh = randomBytes(32);
    writeFileSync(keyPath, safeStorage.encryptString(fresh.toString('hex')), { mode: 0o600 });
    cachedKey = fresh;
    return cachedKey;
  } catch (err) {
    logger.warn('[approvals] signing key load/create failed; decisions will be written unsigned:', err);
    cachedKey = null;
    return cachedKey;
  }
}
