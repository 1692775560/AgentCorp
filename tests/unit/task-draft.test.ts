import { describe, expect, it } from 'vitest';

import {
  buildTaskDraftMessages,
  parseTaskDraft,
  type TeamChatBubble,
} from '@/lib/team-task-chat';

function bubble(kind: TeamChatBubble['kind'], text: string, peerId = 'user'): TeamChatBubble {
  return { id: `b-${text}`, kind, actorId: kind === 'user' ? 'user' : 'leader', peerId, text, round: null, verdict: null };
}

describe('buildTaskDraftMessages', () => {
  it('携带最近对话与最新指令', () => {
    const msgs = buildTaskDraftMessages('开工吧', [
      bubble('user', '帮我调研一下中国皮肤病常见病发病的案例'),
      bubble('a2a', '好的，我建议分病种梳理…'),
    ]);
    const user = msgs[msgs.length - 1].content;
    expect(user).toContain('皮肤病');
    expect(user).toContain('开工吧');
    expect(msgs[0].content).toContain('需求整理助手');
  });

  it('只带对话气泡（协作 trace 不混入），最多 10 条、单条截 300 字', () => {
    const history: TeamChatBubble[] = [
      bubble('a2a', '子任务指派 trace', 'm1'), // peerId 非 user → 过滤
      ...Array.from({ length: 12 }, (_, i) => bubble('user', `第${i + 1}条 ${'x'.repeat(400)}`)),
    ];
    const msgs = buildTaskDraftMessages('开工', history);
    const user = msgs[msgs.length - 1].content;
    expect(user).not.toContain('子任务指派 trace');
    expect(user).not.toContain('第1条');
    expect(user).not.toContain('第2条');
    expect(user).toContain('第12条');
    expect(user).not.toContain('x'.repeat(301));
  });
});

describe('parseTaskDraft', () => {
  it('解析裸 JSON', () => {
    expect(parseTaskDraft('{"title":"皮肤病调研","requirement":"调研中国常见皮肤病案例"}')).toEqual({
      title: '皮肤病调研',
      requirement: '调研中国常见皮肤病案例',
    });
  });

  it('容忍代码围栏与解释文字', () => {
    const raw = '好的：\n```json\n{"title":"a","requirement":"b"}\n```\n以上。';
    expect(parseTaskDraft(raw)).toEqual({ title: 'a', requirement: 'b' });
  });

  it('非法 JSON / 缺字段 / 空串 → null', () => {
    expect(parseTaskDraft('这不是 JSON')).toBeNull();
    expect(parseTaskDraft('{"title":"a"}')).toBeNull();
    expect(parseTaskDraft('{"title":"","requirement":"b"}')).toBeNull();
  });

  it('标题超 24 字截断', () => {
    const draft = parseTaskDraft(`{"title":"${'长'.repeat(30)}","requirement":"b"}`);
    expect(draft?.title).toBe(`${'长'.repeat(24)}…`);
  });
});
