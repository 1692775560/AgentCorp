/**
 * tests/unit/schedule-cron.test.ts
 *
 * shared/schedule-cron.ts 纯函数测试：
 * - 5 字段子集语法：*、星号步进、具体数字、逗号列表、非法表达式；
 * - 周日 0/7 等价、日/周 Vixie OR 语义；
 * - nextFireAfter 严格大于 after、单调性、月底边界（2 月 30 日永不触发返回 null）。
 */
import { describe, it, expect } from 'vitest';
import {
  isValidCronExpression,
  nextFireAfter,
  parseCronExpression,
} from '../../shared/schedule-cron';

/** 本地时间构造，与实现里的本地 get/set 一致，避免时区抖动 */
function at(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

function expectFire(cron: string, after: Date, expected: Date) {
  const fireAt = nextFireAfter(cron, after);
  expect(fireAt).not.toBeNull();
  expect(fireAt!.getTime()).toBe(expected.getTime());
}

describe('parseCronExpression / isValidCronExpression', () => {
  it('接受 *、*/n、数字、逗号列表', () => {
    for (const expr of [
      '* * * * *',
      '*/5 * * * *',
      '0 9 * * *',
      '30 8 1 * *',
      '0 9,18 * * *',
      '0 9 * * 1,3,5',
      '0 9 * * 7',
    ]) {
      expect(isValidCronExpression(expr), expr).toBe(true);
      expect(parseCronExpression(expr), expr).not.toBeNull();
    }
  });

  it('拒绝非法表达式：字段数错误、越界、非数字、步进为 0、空串', () => {
    for (const expr of [
      '',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * * 8',
      'a b c d e',
      '*/0 * * * *',
      '1,,2 * * * *',
      '1-5 * * * *', // 范围语法不在子集内
      '0 9 * *', // 少一字段
    ]) {
      expect(isValidCronExpression(expr), JSON.stringify(expr)).toBe(false);
      expect(parseCronExpression(expr), JSON.stringify(expr)).toBeNull();
      expect(nextFireAfter(expr, at(2026, 1, 1)), JSON.stringify(expr)).toBeNull();
    }
  });
});

describe('nextFireAfter', () => {
  it('每分钟：严格大于 after（同一分钟内的下一秒触发点）', () => {
    expectFire('* * * * *', at(2026, 1, 1, 0, 0, 30), at(2026, 1, 1, 0, 1));
    // after 正好落在触发点上 → 取下一分钟
    expectFire('* * * * *', at(2026, 1, 1, 0, 0), at(2026, 1, 1, 0, 1));
  });

  it('*/n 步进：*/15 分', () => {
    expectFire('*/15 * * * *', at(2026, 1, 1, 0, 7), at(2026, 1, 1, 0, 15));
    expectFire('*/15 * * * *', at(2026, 1, 1, 0, 45), at(2026, 1, 1, 1, 0));
  });

  it('具体数字：每天 9:00，跨天回绕', () => {
    expectFire('0 9 * * *', at(2026, 1, 1, 8, 59), at(2026, 1, 1, 9, 0));
    expectFire('0 9 * * *', at(2026, 1, 1, 9, 0), at(2026, 1, 2, 9, 0));
    expectFire('0 9 * * *', at(2026, 1, 31, 10, 0), at(2026, 2, 1, 9, 0));
  });

  it('逗号列表：每天 9:00 和 18:00', () => {
    expectFire('0 9,18 * * *', at(2026, 1, 1, 10, 0), at(2026, 1, 1, 18, 0));
    expectFire('0 9,18 * * *', at(2026, 1, 1, 18, 0), at(2026, 1, 2, 9, 0));
  });

  it('日字段：每月 1 日 8:30；月字段：每年 3 月 1 日', () => {
    expectFire('30 8 1 * *', at(2026, 1, 15), at(2026, 2, 1, 8, 30));
    expectFire('0 0 1 3 *', at(2026, 1, 1), at(2026, 3, 1, 0, 0));
  });

  it('周字段：每周一 9:00；周日 0 与 7 等价', () => {
    // 2026-01-05 是周一
    expect(at(2026, 1, 5).getDay()).toBe(1);
    expectFire('0 9 * * 1', at(2026, 1, 4, 10, 0), at(2026, 1, 5, 9, 0));
    expectFire('0 9 * * 1,3', at(2026, 1, 5, 10, 0), at(2026, 1, 7, 9, 0)); // 周三

    // 2026-01-04 是周日
    expect(at(2026, 1, 4).getDay()).toBe(0);
    expectFire('0 9 * * 0', at(2026, 1, 3), at(2026, 1, 4, 9, 0));
    expectFire('0 9 * * 7', at(2026, 1, 3), at(2026, 1, 4, 9, 0));
  });

  it('日/周同时受限时是 Vixie OR 语义：每月 1 日 或 每周一', () => {
    // 2026-01-05 周一；2026-02-01 是 2 月 1 日（周日）
    expect(at(2026, 2, 1).getDay()).toBe(0);
    expectFire('0 9 1 * 1', at(2026, 1, 2), at(2026, 1, 5, 9, 0));
    expectFire('0 9 1 * 1', at(2026, 1, 5, 10, 0), at(2026, 1, 12, 9, 0));
    expectFire('0 9 1 * 1', at(2026, 1, 31), at(2026, 2, 1, 9, 0));
  });

  it('月底边界：2 月 30 日永不触发，搜索窗口耗尽返回 null', () => {
    expect(nextFireAfter('0 9 30 2 *', at(2026, 1, 1))).toBeNull();
    // 2 月 29 日：2028 是闰年，4 年窗口内能搜到
    const leapFire = nextFireAfter('0 9 29 2 *', at(2026, 3, 1));
    expect(leapFire).not.toBeNull();
    expect(leapFire!.getFullYear()).toBe(2028);
    expect(leapFire!.getMonth()).toBe(1);
    expect(leapFire!.getDate()).toBe(29);
  });

  it('月末回绕不错位：31 日的任务在短月跳到下月', () => {
    // 2026-04 只有 30 天，31 日任务从 4 月中旬出发应落在 5 月 31 日
    expectFire('0 9 31 * *', at(2026, 4, 15), at(2026, 5, 31, 9, 0));
  });

  it('单调性：以触发结果作为下一次基准，序列严格递增且不丢触发点', () => {
    const cron = '0 9 * * *';
    let cursor = at(2026, 1, 1, 0, 0);
    const fires: number[] = [];
    for (let i = 0; i < 5; i++) {
      const next = nextFireAfter(cron, cursor);
      expect(next).not.toBeNull();
      expect(next!.getTime()).toBeGreaterThan(cursor.getTime());
      fires.push(next!.getTime());
      cursor = next!;
    }
    // 每天一次：相邻触发间隔恰好 24h（不考虑 DST 切换日）
    for (let i = 1; i < fires.length; i++) {
      const gapHours = (fires[i] - fires[i - 1]) / (60 * 60 * 1000);
      // DST 切换日允许 23/25h
      expect([23, 24, 25]).toContain(gapHours);
    }
  });
});
