/**
 * tests/unit/reactionsRemote.test.ts
 *
 * 跨用户点赞同步层的纯函数单测（electron/api/reactions-remote.ts）。
 *
 * 覆盖三个不发网络请求的函数：
 *   isRemoteEnabled  —— 远端开关与 URL 协议白名单
 *   deriveVoterId    —— 匿名投票者标识的稳定性与不可逆性
 *   mergeLikeCount   —— 本地/远端计数合并策略
 *
 * 不覆盖 fetchRemote* / pushRemote*：它们的行为取决于真实 HTTP 响应，
 * 属于协作者接后端时的集成测试范围。
 *
 * 运行：npx vitest run tests/unit/reactionsRemote.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  deriveVoterId,
  isRemoteEnabled,
  mergeLikeCount,
} from '../../electron/api/reactions-remote';

const ENV_KEY = 'AGENTCORP_REACTIONS_API';

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe('isRemoteEnabled', () => {
  it('未配置时关闭，保证默认走纯本地路径', () => {
    delete process.env[ENV_KEY];
    expect(isRemoteEnabled()).toBe(false);
  });

  it('配置 https 时开启', () => {
    process.env[ENV_KEY] = 'https://api.example.com/v1';
    expect(isRemoteEnabled()).toBe(true);
  });

  it('拒绝明文 http，避免 Bearer 凭据走明文', () => {
    process.env[ENV_KEY] = 'http://api.example.com/v1';
    expect(isRemoteEnabled()).toBe(false);
  });

  it('放开 localhost 明文，便于协作者本地联调', () => {
    process.env[ENV_KEY] = 'http://127.0.0.1:8080';
    expect(isRemoteEnabled()).toBe(true);
    process.env[ENV_KEY] = 'http://localhost:8080';
    expect(isRemoteEnabled()).toBe(true);
  });

  it('非法 URL 视为未配置而非抛错', () => {
    process.env[ENV_KEY] = 'not a url';
    expect(isRemoteEnabled()).toBe(false);
  });

  it('空白字符串视为未配置', () => {
    process.env[ENV_KEY] = '   ';
    expect(isRemoteEnabled()).toBe(false);
  });
});

describe('deriveVoterId', () => {
  it('同一 seed 恒定映射到同一 voterId，重启后不会重复计数', () => {
    expect(deriveVoterId('seed-a')).toBe(deriveVoterId('seed-a'));
  });

  it('不同 seed 得到不同 voterId', () => {
    expect(deriveVoterId('seed-a')).not.toBe(deriveVoterId('seed-b'));
  });

  it('不回显原始 seed，避免把设备标识泄露给远端', () => {
    const seed = 'device-fingerprint-123';
    expect(deriveVoterId(seed)).not.toContain(seed);
  });

  it('输出为 16 位十六进制', () => {
    expect(deriveVoterId('seed-a')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('空 seed 落到 anonymous 而非抛错', () => {
    expect(deriveVoterId('')).toBe('anonymous');
  });
});

describe('mergeLikeCount', () => {
  it('远端可用时以远端为权威，即使小于本地', () => {
    // 本地是单机自增，多设备下必然偏大，远端才是真实人气
    expect(mergeLikeCount(7, { agentId: 'a', count: 3, updatedAt: '' })).toBe(3);
  });

  it('远端大于本地时同样取远端', () => {
    expect(mergeLikeCount(2, { agentId: 'a', count: 128, updatedAt: '' })).toBe(128);
  });

  it('远端不可用时回落本地，保证离线可用', () => {
    expect(mergeLikeCount(5, null)).toBe(5);
  });

  it('远端返回非法计数时回落本地，不把 NaN 写进 UI', () => {
    expect(mergeLikeCount(5, { agentId: 'a', count: Number.NaN, updatedAt: '' })).toBe(5);
    expect(
      mergeLikeCount(5, { agentId: 'a', count: 'many' as unknown as number, updatedAt: '' }),
    ).toBe(5);
  });

  it('远端返回负数时夹到 0，人气数不可能为负', () => {
    expect(mergeLikeCount(5, { agentId: 'a', count: -3, updatedAt: '' })).toBe(0);
  });
});
