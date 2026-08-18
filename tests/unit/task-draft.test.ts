import { describe, expect, it } from 'vitest';

import {
  buildTaskDraftEvent,
  buildTaskDraftResolution,
  buildTaskIntakeMessages,
  collectTaskDraftResolutions,
  isTaskProtocolContent,
  parseTaskDraftEvent,
  parseTaskDraftResolution,
  parseTaskIntake,
  type TeamChatBubble,
} from '@/lib/team-task-chat';

function bubble(kind: TeamChatBubble['kind'], text: string, peerId = 'user'): TeamChatBubble {
  return { id: `b-${text}`, kind, actorId: kind === 'user' ? 'user' : 'leader', peerId, text, round: null, verdict: null };
}

describe('buildTaskIntakeMessages', () => {
  it('携带最近对话与最新指令，说明三分类契约', () => {
    const msgs = buildTaskIntakeMessages('开工吧', [
      bubble('user', '帮我调研一下中国皮肤病常见病发病的案例'),
      bubble('a2a', '好的，我建议分病种梳理…'),
    ], true);
    const user = msgs[msgs.length - 1].content;
    expect(user).toContain('皮肤病');
    expect(user).toContain('开工吧');
    expect(msgs[0].content).toContain('立项助手');
    expect(msgs[0].content).toContain('REWORK');
    expect(msgs[0].content).toContain('短或含糊');
  });

  it('无当前任务时不给 REWORK 选项', () => {
    const msgs = buildTaskIntakeMessages('做个计算器', [], false);
    expect(msgs[0].content).not.toContain('REWORK');
  });

  it('只带对话气泡（协作 trace 不混入），最多 10 条、单条截 300 字', () => {
    const history: TeamChatBubble[] = [
      bubble('a2a', '子任务指派 trace', 'm1'), // peerId 非 user → 过滤
      ...Array.from({ length: 12 }, (_, i) => bubble('user', `第${i + 1}条 ${'x'.repeat(400)}`)),
    ];
    const msgs = buildTaskIntakeMessages('开工', history, false);
    const user = msgs[msgs.length - 1].content;
    expect(user).not.toContain('子任务指派 trace');
    expect(user).not.toContain('第1条');
    expect(user).not.toContain('第2条');
    expect(user).toContain('第12条');
    expect(user).not.toContain('x'.repeat(301));
  });
});

describe('parseTaskIntake', () => {
  it('解析 new：带标题与需求', () => {
    expect(parseTaskIntake('{"intent":"NEW","title":"皮肤病调研","requirement":"调研中国常见皮肤病案例"}')).toEqual({
      intent: 'new',
      title: '皮肤病调研',
      requirement: '调研中国常见皮肤病案例',
    });
  });

  it('解析 chat：无 title/requirement', () => {
    expect(parseTaskIntake('{"intent":"CHAT","title":"","requirement":""}')).toEqual({ intent: 'chat' });
  });

  it('解析 rework', () => {
    expect(parseTaskIntake('{"intent":"REWORK","title":"a","requirement":"b"}')?.intent).toBe('rework');
  });

  it('容忍代码围栏与解释文字', () => {
    const raw = '好的：\n```json\n{"intent":"NEW","title":"a","requirement":"b"}\n```\n以上。';
    expect(parseTaskIntake(raw)).toEqual({ intent: 'new', title: 'a', requirement: 'b' });
  });

  it('非法 JSON / 未知 intent → 保守回退', () => {
    expect(parseTaskIntake('这不是 JSON')).toBeNull();
    expect(parseTaskIntake('{"intent":"WHATEVER"}')?.intent).toBe('chat');
  });

  it('标题超 24 字截断', () => {
    const intake = parseTaskIntake(`{"intent":"NEW","title":"${'长'.repeat(30)}","requirement":"b"}`);
    expect(intake?.title).toBe(`${'长'.repeat(24)}…`);
  });
});

describe('立项确认卡协议', () => {
  it('草稿事件往返解析', () => {
    const content = buildTaskDraftEvent({ title: '皮肤病调研', requirement: '调研中国常见皮肤病' });
    const card = parseTaskDraftEvent(content);
    expect(card?.title).toBe('皮肤病调研');
    expect(card?.requirement).toBe('调研中国常见皮肤病');
    expect(card?.id).toMatch(/^d.+-1$/);
  });

  it('草稿事件缺字段/非协议内容 → null', () => {
    expect(parseTaskDraftEvent('[task-draft]{"id":"x","title":"","requirement":"b"}')).toBeNull();
    expect(parseTaskDraftEvent('普通聊天内容')).toBeNull();
    expect(parseTaskDraftEvent('[task-draft]不是JSON')).toBeNull();
  });

  it('处置事件往返解析，非法 action → null', () => {
    const content = buildTaskDraftResolution('d1-1', 'confirmed');
    expect(parseTaskDraftResolution(content)).toEqual({ id: 'd1-1', action: 'confirmed' });
    expect(parseTaskDraftResolution('[task-draft-resolution]{"id":"x","action":"bogus"}')).toBeNull();
    expect(parseTaskDraftResolution('普通聊天')).toBeNull();
  });

  it('协议内容识别：草稿与处置都不是对话气泡', () => {
    expect(isTaskProtocolContent(buildTaskDraftEvent({ title: 'a', requirement: 'b' }))).toBe(true);
    expect(isTaskProtocolContent(buildTaskDraftResolution('d1-1', 'cancelled'))).toBe(true);
    expect(isTaskProtocolContent('老板说的话')).toBe(false);
  });

  it('处置汇总：同一 id 多条处置时最新一条生效', () => {
    const map = collectTaskDraftResolutions([
      { content: buildTaskDraftResolution('d1-1', 'confirmed') },
      { content: '普通聊天' },
      { content: buildTaskDraftResolution('d2-1', 'cancelled') },
      { content: buildTaskDraftResolution('d1-1', 'superseded') },
    ]);
    expect(map.get('d1-1')).toBe('superseded');
    expect(map.get('d2-1')).toBe('cancelled');
    expect(map.size).toBe(2);
  });
});
