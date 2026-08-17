import { describe, expect, it } from 'vitest';

import {
  buildTeamChatMessages,
  buildTeamChatRenderItems,
  buildWorkOrderClassifierMessages,
  isNearBottom,
  mapEventsToTeamChatBubbles,
  parseExecuteMarker,
  parseMentionTarget,
} from '@/lib/team-task-chat';
import { isAvatarImage } from '@/lib/utils';
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


describe('chat: 对话事件映射', () => {
  it('chat:user→agent 映射为右列用户气泡，peerId 是目标成员', () => {
    const bubbles = mapEventsToTeamChatBubbles([
      ev('chat:user→dev-1', '@阿强 这个样式再改改'),
    ]);
    expect(bubbles[0].kind).toBe('user');
    expect(bubbles[0].actorId).toBe('user');
    expect(bubbles[0].peerId).toBe('dev-1');
    expect(bubbles[0].verdict).toBeNull();
  });

  it('chat:agent→user 映射为左列成员气泡，actorId 是发言成员', () => {
    const bubbles = mapEventsToTeamChatBubbles([
      ev('chat:leader-1→user', '收到，我来安排'),
    ]);
    expect(bubbles[0].kind).toBe('a2a');
    expect(bubbles[0].actorId).toBe('leader-1');
    expect(bubbles[0].peerId).toBe('user');
  });

  it('chat: 事件不参与 PASS/REWORK 解析，轮次为 null', () => {
    const bubbles = mapEventsToTeamChatBubbles([
      ev('chat:leader-1→user', '这版 PASS 了，别担心'),
    ]);
    expect(bubbles[0].verdict).toBeNull();
    expect(bubbles[0].round).toBeNull();
  });
});

describe('parseMentionTarget', () => {
  const members = [
    { id: 'leader-1', name: '阿明' },
    { id: 'dev-1', name: '阿强' },
  ];

  it('命中 @成员名 返回该成员并剥离提及', () => {
    const r = parseMentionTarget('@阿强 样式再改改', members);
    expect(r?.targetId).toBe('dev-1');
    expect(r?.cleanText).toBe('样式再改改');
  });

  it('提及出现在文中也能命中', () => {
    const r = parseMentionTarget('麻烦 @阿明 看一下进度', members);
    expect(r?.targetId).toBe('leader-1');
    expect(r?.cleanText).toBe('麻烦 看一下进度');
  });

  it('未命中返回 null（调用方默认发 leader）', () => {
    expect(parseMentionTarget('进度怎么样了', members)).toBeNull();
    expect(parseMentionTarget('@不存在的人 你好', members)).toBeNull();
  });
});

describe('buildTeamChatMessages', () => {
  const leader = { id: 'leader-1', name: '阿明', persona: '沉稳可靠', responsibility: '拆解与审阅', isLeader: true };
  const ctx = { taskTitle: '做一个计算器', taskDescription: '支持加减乘除', teamName: '交付一组' };
  const history = mapEventsToTeamChatBubbles([
    ev('a2a:leader-1→dev-1', '【第1轮】分派：实现 UI'),           // 协作 trace，不进对话上下文
    ev('chat:user→leader-1', '进度怎么样？'),
    ev('chat:leader-1→user', '第一轮已通过，正在收尾'),
    ev('chat:user→dev-1', '@阿强 样式改下'),                      // 发给别人的话
  ]);

  it('system 含人设、职责与任务背景', () => {
    const msgs = buildTeamChatMessages(leader, ctx, history, '新消息');
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('阿明');
    expect(msgs[0].content).toContain('沉稳可靠');
    expect(msgs[0].content).toContain('做一个计算器');
    expect(msgs[0].content).toContain('负责人');
  });

  it('历史只含 chat: 对话，协作 trace 不混入；本人回复为 assistant', () => {
    const msgs = buildTeamChatMessages(leader, ctx, history, '新消息');
    const roles = msgs.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user', 'user']);
    expect(msgs[1].content).toBe('进度怎么样？');
    expect(msgs[2].content).toBe('第一轮已通过，正在收尾');
    // 发给其他成员的话标注对象，避免误会
    expect(msgs[3].content).toContain('（对另一位成员说）');
    // 最后一条是新用户消息
    expect(msgs[4].content).toBe('新消息');
    // 协作 trace 不出现
    expect(msgs.some((m) => m.content.includes('分派：实现 UI'))).toBe(false);
  });

  it('交付摘要截断注入 system', () => {
    const msgs = buildTeamChatMessages(leader, { ...ctx, workResultExcerpt: '已完成 9/9 回归' }, [], '问');
    expect(msgs[0].content).toContain('已完成 9/9 回归');
  });
});


describe('isAvatarImage', () => {
  it('data URI / http URL / 路径判定为图片', () => {
    expect(isAvatarImage('data:image/png;base64,WQ9InZpZXZ')).toBe(true);
    expect(isAvatarImage('https://example.com/a.png')).toBe(true);
    expect(isAvatarImage('/avatars/a.png')).toBe(true);
  });

  it('emoji 与空值按文本处理', () => {
    expect(isAvatarImage('🤖')).toBe(false);
    expect(isAvatarImage('')).toBe(false);
    expect(isAvatarImage(null)).toBe(false);
    expect(isAvatarImage(undefined)).toBe(false);
  });
});


describe('buildTeamChatRenderItems', () => {
  const seq = (events: TaskExecutionEvent[]) => mapEventsToTeamChatBubbles(events);

  it('交付气泡插在协作过程末尾、后续对话之前', () => {
    const items = buildTeamChatRenderItems(seq([
      ev('a2a:leader-1→dev-1', '【第1轮】分派'),
      ev('a2a:dev-1→leader-1', '【第1轮】审阅：PASS'),
      ev('chat:user→leader-1', '做得怎么样？'),
      ev('chat:leader-1→user', '已完成'),
    ]), true);
    expect(items.map((i) => i.key)).toEqual(['a2a-0', 'a2a-1', '__delivery__', 'chat-2', 'chat-3']);
  });

  it('纯对话流时交付气泡排在对话之前', () => {
    const items = buildTeamChatRenderItems(seq([
      ev('chat:user→leader-1', '你好'),
      ev('chat:leader-1→user', '你好，老板'),
    ]), true);
    expect(items.map((i) => i.key)).toEqual(['__delivery__', 'chat-0', 'chat-1']);
  });

  it('纯协作流时交付气泡排在最后', () => {
    const items = buildTeamChatRenderItems(seq([
      ev('status', '任务已领取'),
      ev('a2a:leader-1→dev-1', '【第1轮】分派'),
    ]), true);
    expect(items.map((i) => i.key)).toEqual(['sys-0', 'a2a-1', '__delivery__']);
  });

  it('无交付物时不插入交付气泡', () => {
    const items = buildTeamChatRenderItems(seq([ev('status', '任务已领取')]), false);
    expect(items).toHaveLength(1);
    expect(items[0].delivery).toBeUndefined();
  });

  it('空消息流 + 有交付物：交付气泡单独存在', () => {
    const items = buildTeamChatRenderItems([], true);
    expect(items).toHaveLength(1);
    expect(items[0].delivery).toBe(true);
  });
});


describe('parseExecuteMarker', () => {
  it('行尾独立 [EXECUTE] 被识别并剥离', () => {
    const r = parseExecuteMarker('收到，我这就安排阿强改样式。\n[EXECUTE]');
    expect(r.execute).toBe(true);
    expect(r.text).toBe('收到，我这就安排阿强改样式。');
  });

  it('标记前后有空白也能识别', () => {
    const r = parseExecuteMarker('马上办。\n  [EXECUTE]  ');
    expect(r.execute).toBe(true);
    expect(r.text).toBe('马上办。');
  });

  it('正文中间提到 [EXECUTE] 不误判', () => {
    const r = parseExecuteMarker('我不会输出 [EXECUTE] 标记，因为这只是闲聊。');
    expect(r.execute).toBe(false);
    expect(r.text).toContain('[EXECUTE]');
  });

  it('普通回复原样返回', () => {
    const r = parseExecuteMarker('团队成员有阿强和阿珍。');
    expect(r.execute).toBe(false);
    expect(r.text).toBe('团队成员有阿强和阿珍。');
  });
});

describe('buildTeamChatMessages 派活约定', () => {
  const ctx = { taskTitle: '做一个计算器', teamName: '交付一组' };

  it('leader 的 system 含 [EXECUTE] 标记约定', () => {
    const msgs = buildTeamChatMessages(
      { id: 'leader-1', name: '阿明', isLeader: true },
      ctx,
      [],
      '把样式改炫酷点',
    );
    expect(msgs[0].content).toContain('[EXECUTE]');
    expect(msgs[0].content).toContain('派活');
  });

  it('普通成员的 system 不含执行标记约定', () => {
    const msgs = buildTeamChatMessages(
      { id: 'dev-1', name: '阿强', isLeader: false },
      ctx,
      [],
      '样式改下',
    );
    expect(msgs[0].content).not.toContain('[EXECUTE]');
  });
});


describe('buildWorkOrderClassifierMessages', () => {
  it('分类器为独立 YES/NO 小调用，携带待判文本', () => {
    const msgs = buildWorkOrderClassifierMessages('把样式改炫酷一点');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('YES');
    expect(msgs[0].content).toContain('NO');
    expect(msgs[0].content).toContain('闲聊');
    expect(msgs[1]).toEqual({ role: 'user', content: '把样式改炫酷一点' });
  });
});


describe('isNearBottom', () => {
  it('距底部阈值内判定为在底部', () => {
    expect(isNearBottom(1000, 500, 500)).toBe(true);   // 正好贴底
    expect(isNearBottom(1000, 430, 500)).toBe(true);   // 差 70px，阈值内
  });

  it('上滑超过阈值判定为不在底部', () => {
    expect(isNearBottom(1000, 200, 500)).toBe(false);  // 差 300px
    expect(isNearBottom(1000, 419, 500)).toBe(false);  // 差 81px，超阈值
  });

  it('内容不足一屏时始终在底部', () => {
    expect(isNearBottom(400, 0, 500)).toBe(true);
  });
});
