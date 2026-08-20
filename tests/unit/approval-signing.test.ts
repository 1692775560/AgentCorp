/**
 * tests/unit/approval-signing.test.ts
 * 审批决策签名（approval-signing.ts）：
 * 真实决策带 HMAC-SHA256 签名；agent 在可写目录里伪造/篡改的决策验签不过。
 * 密钥管理（safeStorage 落 userData）在 approval-signing-key.ts，属 Electron 侧，不在此测。
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import {
  canonicalDecisionPayload,
  signDecision,
  verifyDecisionSignature,
} from '../../electron/utils/approval-signing';

const key = randomBytes(32);
const otherKey = randomBytes(32);

const decision = {
  approvalId: 'appr-123',
  action: 'approve' as const,
  reason: '用户确认',
  decidedAt: '2026-08-20T05:00:00.000Z',
};

describe('approval-signing', () => {
  it('签名-验签往返一致', () => {
    const signed = { ...decision, signature: signDecision(decision, key) };
    expect(verifyDecisionSignature(signed, key)).toBe(true);
  });

  it('伪造决策（无签名 / 错密钥）→ 验签拒绝', () => {
    expect(verifyDecisionSignature(decision, key)).toBe(false);
    const forged = { ...decision, signature: signDecision(decision, otherKey) };
    expect(verifyDecisionSignature(forged, key)).toBe(false);
  });

  it('篡改任一字段（改 action 为 approve）→ 验签拒绝', () => {
    const reject = { ...decision, action: 'reject' as const, reason: '用户驳回' };
    const signed = { ...reject, signature: signDecision(reject, key) };
    // agent 把 reject 改成 approve，签名不动 → 必须验不过
    const tampered = { ...signed, action: 'approve' as const };
    expect(verifyDecisionSignature(tampered, key)).toBe(false);
  });

  it('签名格式不对（非 64 位 hex）→ 拒绝且不抛错', () => {
    expect(verifyDecisionSignature({ ...decision, signature: 'zzz' }, key)).toBe(false);
    expect(verifyDecisionSignature({ ...decision, signature: '' }, key)).toBe(false);
    expect(verifyDecisionSignature({ ...decision, signature: 123 as unknown as string }, key)).toBe(false);
  });

  it('规范化载荷固定字段顺序，reason 缺省按空串参与签名', () => {
    const noReason = { approvalId: 'a', action: 'approve' as const, decidedAt: 't' };
    expect(canonicalDecisionPayload(noReason))
      .toBe('{"approvalId":"a","action":"approve","reason":"","decidedAt":"t"}');
    // reason 显式空串与缺省应得到同一签名
    expect(signDecision(noReason, key)).toBe(signDecision({ ...noReason, reason: '' }, key));
  });
});
