/**
 * electron/utils/approval-signing.ts
 * 审批决策的 HMAC-SHA256 签名（纯 Node crypto，零 Electron 依赖，可直接单测）。
 *
 * 背景：审批决策以 JSON 文件（~/.openclaw/approvals/decisions.json）交换，
 * 而 ~/.openclaw 是 agent 可写目录——被 prompt 注入的 agent 可以自己写一条
 * approve 决策完成「自批」。本模块给每条真实决策附加签名：
 * 密钥由主进程持有（见 approval-signing-key.ts，safeStorage 加密存 userData，
 * 在 agent 可写目录之外），agent 伪造的决策没有有效签名。
 *
 * 信任边界（如实说明）：决策文件的消费方是外部 OpenClaw gateway，
 * 验签需 gateway 侧配合；在仓库内签名提供的是**可审计的完整性证据**——
 * 任何时刻都可以离线校验 decisions.json，把伪造条目揪出来。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignableDecision {
  approvalId: string;
  action: 'approve' | 'reject';
  reason?: string;
  decidedAt: string;
}

export interface SignedDecision extends SignableDecision {
  signature?: string;
}

/** 规范化载荷：固定字段顺序，签名/验签两边必须逐字节一致。 */
export function canonicalDecisionPayload(entry: SignableDecision): string {
  return JSON.stringify({
    approvalId: entry.approvalId,
    action: entry.action,
    reason: entry.reason ?? '',
    decidedAt: entry.decidedAt,
  });
}

/** 对决策签名，返回 hex HMAC-SHA256。 */
export function signDecision(entry: SignableDecision, key: Buffer): string {
  return createHmac('sha256', key).update(canonicalDecisionPayload(entry), 'utf8').digest('hex');
}

/** 验签：签名缺失/格式不对/内容被篡改都判 false。时序安全比较。 */
export function verifyDecisionSignature(entry: SignedDecision, key: Buffer): boolean {
  if (typeof entry.signature !== 'string' || !/^[0-9a-f]{64}$/.test(entry.signature)) {
    return false;
  }
  const expected = Buffer.from(signDecision(entry, key), 'hex');
  const actual = Buffer.from(entry.signature, 'hex');
  return timingSafeEqual(expected, actual);
}
