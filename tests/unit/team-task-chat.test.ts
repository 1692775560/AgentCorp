import { describe, expect, it } from 'vitest';

import {
  buildDirectAssignInstruction,
  buildTeamChatMessages,
  buildTeamChatRenderItems,
  buildWorkIntentClassifierMessages,
  findReviewTaskForDelivery,
  isNearBottom,
  mapEventsToTeamChatBubbles,
  mapTeamChatEventsToBubbles,
  parseDirectAssignTarget,
  parseExecuteMarker,
  parseMentionTarget,
  parseWorkIntent,
  stripActorPrefix,
  taskTitleFromInstruction,
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


describe('buildWorkIntentClassifierMessages + parseWorkIntent', () => {
  it('有当前任务时提供 REWORK/NEW/CHAT 三分类', () => {
    const msgs = buildWorkIntentClassifierMessages('把样式改炫酷一点', true);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('REWORK');
    expect(msgs[0].content).toContain('NEW');
    expect(msgs[0].content).toContain('CHAT');
    expect(msgs[0].content).toContain('催促');
    expect(msgs[1]).toEqual({ role: 'user', content: '把样式改炫酷一点' });
  });

  it('无当前任务时只分 NEW/CHAT', () => {
    const msgs = buildWorkIntentClassifierMessages('做个小游戏', false);
    expect(msgs[0].content).toContain('NEW');
    expect(msgs[0].content).not.toContain('REWORK');
  });

  it('parseWorkIntent 解析与兜底', () => {
    expect(parseWorkIntent('REWORK')).toBe('rework');
    expect(parseWorkIntent('NEW')).toBe('new');
    expect(parseWorkIntent('CHAT')).toBe('chat');
    expect(parseWorkIntent('new.')).toBe('new');
    expect(parseWorkIntent('随便什么别的')).toBe('chat');
    expect(parseWorkIntent('')).toBe('chat');
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


describe('mapTeamChatEventsToBubbles', () => {
  it('from=user 为右列用户气泡，from=agentId 为左列成员气泡', () => {
    const bubbles = mapTeamChatEventsToBubbles([
      { from: 'user', to: 'leader-1', content: '进度如何', createdAt: '2026-08-18T10:00:00Z' },
      { from: 'leader-1', to: 'user', content: '顺利推进中', createdAt: '2026-08-18T10:00:05Z' },
    ]);
    expect(bubbles[0]).toMatchObject({ kind: 'user', actorId: 'user', peerId: 'leader-1' });
    expect(bubbles[1]).toMatchObject({ kind: 'a2a', actorId: 'leader-1', peerId: 'user' });
    expect(bubbles[1].verdict).toBeNull();
    expect(bubbles[1].round).toBeNull();
  });
});

describe('stripActorPrefix / 编排 trace 前缀剥离', () => {
  it('stripActorPrefix 剥 agent:/team: 前缀，无前缀原样返回', () => {
    expect(stripActorPrefix('agent:writer-01')).toBe('writer-01');
    expect(stripActorPrefix('team:team-1')).toBe('team-1');
    expect(stripActorPrefix('writer-01')).toBe('writer-01');
    expect(stripActorPrefix('user')).toBe('user');
    expect(stripActorPrefix('')).toBe('');
  });

  it('a2a 事件的 actorId/peerId 剥掉 agent: 前缀（编排 trace 的 id 不再泄漏到 UI）', () => {
    const bubbles = mapEventsToTeamChatBubbles([
      ev('a2a:agent:leader-1 → agent:dev-1', '【第1轮】分派：实现 UI'),
    ]);
    expect(bubbles[0].actorId).toBe('dev-1');
    expect(bubbles[0].peerId).toBe('leader-1');
  });

  it('a2a 事件的 team: 前缀同样剥离为裸 team id（显示层按 team id 回退团队名）', () => {
    const bubbles = mapEventsToTeamChatBubbles([
      ev('a2a:team:team-1 → agent:dev-1', '团队分派'),
    ]);
    expect(bubbles[0].actorId).toBe('dev-1');
    expect(bubbles[0].peerId).toBe('team-1');
  });

  it('chat: 对话事件的 id 也剥前缀', () => {
    const bubbles = mapEventsToTeamChatBubbles([
      ev('chat:agent:leader-1→user', '收到'),
      ev('chat:user→agent:dev-1', '@阿强 改下样式'),
    ]);
    expect(bubbles[0].actorId).toBe('leader-1');
    expect(bubbles[1].peerId).toBe('dev-1');
  });

  it('房间事件（mapTeamChatEventsToBubbles）同样剥前缀', () => {
    const bubbles = mapTeamChatEventsToBubbles([
      { from: 'user', to: 'agent:leader-1', content: '进度如何', createdAt: '2026-08-18T10:00:00Z' },
      { from: 'agent:leader-1', to: 'user', content: '顺利推进中', createdAt: '2026-08-18T10:00:05Z' },
    ]);
    expect(bubbles[0].peerId).toBe('leader-1');
    expect(bubbles[1].actorId).toBe('leader-1');
  });
});

describe('taskTitleFromInstruction', () => {
  it('取首行，超过 24 字截断加省略号', () => {
    expect(taskTitleFromInstruction('做一个计算器\n详细要求如下')).toBe('做一个计算器');
    expect(taskTitleFromInstruction('把计算器改成深色主题并且加一个历史记录功能还要支持键盘')).toBe('把计算器改成深色主题并且加一个历史记录功能还要支…');
  });

  it('空文本回退默认标题', () => {
    expect(taskTitleFromInstruction('\n  \n')).toBe('团队任务');
  });
});

describe('buildTeamChatMessages 团队房间场景', () => {
  it('不传 taskTitle 时是日常沟通口吻', () => {
    const msgs = buildTeamChatMessages(
      { id: 'leader-1', name: '阿明', isLeader: true },
      { teamName: '马斯克团队' },
      [],
      '最近怎么样',
    );
    expect(msgs[0].content).toContain('团队日常');
    expect(msgs[0].content).toContain('马斯克团队');
    expect(msgs[0].content).not.toContain('任务「');
  });
});


describe('buildTeamChatMessages 诚实约束', () => {
  const agent = { id: 'leader-1', name: '阿明', isLeader: true };

  it('交付物就绪时告知去交付区获取，不许承诺「马上发」', () => {
    const msgs = buildTeamChatMessages(agent, { taskTitle: '计算器', deliveryReady: true }, [], '还没给我吗');
    expect(msgs[0].content).toContain('交付物已保存到本地');
    expect(msgs[0].content).toContain('不要假装');
  });

  it('无论是否交付就绪，都声明没有真实执行/发送能力', () => {
    const msgs = buildTeamChatMessages(agent, { teamName: '交付一组' }, [], '在吗');
    expect(msgs[0].content).toContain('无法真的去执行或发送');
    expect(msgs[0].content).not.toContain('交付物已保存到本地');
  });
});


describe('findReviewTaskForDelivery（房间交付消息 → 可验收任务）', () => {
  const tasks = [
    { id: 't1', title: '做调研', status: 'review' },
    { id: 't2', title: '写文案', status: 'done' },
    { id: 't3', title: '画海报', status: 'in-progress' },
  ];

  it('唯一匹配 review 任务 → 返回该任务（显示验收按钮）', () => {
    const t = findReviewTaskForDelivery('「做调研」交付完成，请验收：\n\n结果内容', tasks);
    expect(t?.id).toBe('t1');
  });

  it('同名任务有多个在 review → 多义不显示', () => {
    const dup = [
      { id: 't1', title: '做调研', status: 'review' },
      { id: 't4', title: '做调研', status: 'review' },
    ];
    expect(findReviewTaskForDelivery('「做调研」交付完成，请验收：x', dup)).toBeNull();
  });

  it('匹配到任务但非 review 态（done/in-progress）→ 不显示', () => {
    expect(findReviewTaskForDelivery('「写文案」交付完成，请验收：x', tasks)).toBeNull();
    expect(findReviewTaskForDelivery('「画海报」交付完成，请验收：x', tasks)).toBeNull();
  });

  it('非交付消息 / 无对应任务 → 不显示', () => {
    expect(findReviewTaskForDelivery('进度汇报：一切顺利', tasks)).toBeNull();
    expect(findReviewTaskForDelivery('「不存在的任务」交付完成，请验收：x', tasks)).toBeNull();
  });
});

describe('parseDirectAssignTarget（@成员直派解析）', () => {
  const members = [
    { id: 'leader-1', name: '阿明' },
    { id: 'dev-1', name: '阿强' },
    { id: 'design-1', name: '阿珍' },
  ];

  it('@非 leader 成员 + 指令正文 → 直派该成员', () => {
    const r = parseDirectAssignTarget('@阿强 把登录页样式重构一下', members, 'leader-1');
    expect(r).toEqual({ targetId: 'dev-1', targetName: '阿强', instruction: '把登录页样式重构一下' });
  });

  it('@leader → 不直派（维持 leader 三路意图管线）', () => {
    expect(parseDirectAssignTarget('@阿明 安排个新活', members, 'leader-1')).toBeNull();
  });

  it('不 @ 任何人 → 不直派', () => {
    expect(parseDirectAssignTarget('做个小游戏', members, 'leader-1')).toBeNull();
  });

  it('只 @ 人没有指令内容 → 不直派', () => {
    expect(parseDirectAssignTarget('@阿强', members, 'leader-1')).toBeNull();
  });

  it('@不存在的成员 → 不直派', () => {
    expect(parseDirectAssignTarget('@路人甲 干活', members, 'leader-1')).toBeNull();
  });
});

describe('buildDirectAssignInstruction', () => {
  it('加指定执行前缀，leader 拆解时带上指定人', () => {
    expect(buildDirectAssignInstruction('阿强', '重构登录页')).toBe('【指定执行：@阿强】重构登录页');
  });
});
