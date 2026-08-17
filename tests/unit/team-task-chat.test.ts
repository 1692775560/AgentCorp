import { describe, expect, it } from 'vitest';

import { mapEventsToTeamChatBubbles } from '@/lib/team-task-chat';
import type { TaskExecutionEvent } from '@/types/task';

function ev(type: string, content: string, createdAt = '2026-08-17T12:00:00Z'): TaskExecutionEvent {
  return { type, content, createdAt };
}

describe('mapEventsToTeamChatBubbles', () => {
  it('A2A 事件映射为 a2a 气泡，发言者是箭头终点（to）', () => {
    const bubbles = mapEventsToTeamChatBubbles([
      ev('a2a:leader-1→dev-1', '【第1轮】leader 分派：实现计算器 UI'),
    ]);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].kind).toBe('a2a');
    expect(bubbles[0].actorId).toBe('dev-1');
    expect(bubbles[0].peerId).toBe('leader-1');
  });

  it('非 A2A 事件映射为 system 气泡', () => {
    const bubbles = mapEventsToTeamChatBubbles([
      ev('status', '任务已领取，开始执行'),
    ]);
    expect(bubbles[0].kind).toBe('system');
    expect(bubbles[0].actorId).toBe('');
    expect(bubbles[0].text).toBe('任务已领取，开始执行');
  });

  it('解析 PASS / REWORK 结论徽章', () => {
    const bubbles = mapEventsToTeamChatBubbles([
      ev('a2a:dev-1→leader-1', '【第1轮】审阅结果：PASS，交付质量达标'),
      ev('a2a:dev-1→leader-1', '【第1轮】审阅结果：REWORK，缺少边界处理'),
      ev('a2a:leader-1→dev-1', '【第1轮】分派任务'),
    ]);
    expect(bubbles[0].verdict).toBe('pass');
    expect(bubbles[1].verdict).toBe('rework');
    expect(bubbles[2].verdict).toBeNull();
  });

  it('提取轮次号并去掉正文里的【第N轮】前缀', () => {
    const bubbles = mapEventsToTeamChatBubbles([
      ev('a2a:leader-1→dev-1', '【第3轮】重做：补充测试用例'),
    ]);
    expect(bubbles[0].round).toBe(3);
    expect(bubbles[0].text).toBe('重做：补充测试用例');
  });

  it('无轮次前缀时 round 为 null，正文原样保留', () => {
    const bubbles = mapEventsToTeamChatBubbles([
      ev('a2a:leader-1→dev-1', '交付工作结果'),
    ]);
    expect(bubbles[0].round).toBeNull();
    expect(bubbles[0].text).toBe('交付工作结果');
  });

  it('无箭头终点的 a2a 事件回退用 from 作为发言者', () => {
    const bubbles = mapEventsToTeamChatBubbles([
      ev('a2a:leader-1', '独白事件'),
    ]);
    expect(bubbles[0].kind).toBe('a2a');
    expect(bubbles[0].actorId).toBe('leader-1');
    expect(bubbles[0].peerId).toBe('');
  });

  it('保留事件顺序与时间戳', () => {
    const bubbles = mapEventsToTeamChatBubbles([
      ev('status', '开始', '2026-08-17T12:00:00Z'),
      ev('a2a:a→b', '干活', '2026-08-17T12:01:00Z'),
    ]);
    expect(bubbles.map((b) => b.kind)).toEqual(['system', 'a2a']);
    expect(bubbles[1].createdAt).toBe('2026-08-17T12:01:00Z');
  });
});
