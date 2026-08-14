/**
 * scripts/demo/a2a-board.mjs
 * 模拟看板 AutoWorker 跑团队任务的完整 A2A 链路：全程走与前端相同的
 * /api/llm/chat 代理（messages[] 通道），验证 leader↔成员真实往返 +
 * 每条消息转成一条 executionEvent（看板时间线渲染用）。
 */
const BASE = 'http://localhost:3000';
async function chat(messages) {
  const r = await fetch(`${BASE}/api/llm/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, maxTokens: 1024 }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.content;
}
const LEADER = 'leader-01', MEMBER = 'member-writer-01';
const TASK = { title: '为 Eazo 待办 App 写首页 Slogan', description: '一句中文，20字内，突出“随手记、不遗漏”。' };
const events = [];
function pushEvent(delegator, delegatee, round, state, summary) {
  const status = state === 'completed' ? 'done' : state === 'failed' ? 'failed' : 'working';
  events.push({ type: `a2a:agent:${delegator} → agent:${delegatee}`, status, content: `【第${round}轮】${summary}`, actorId: delegator });
  console.log(`\n[executionEvent #${events.length}] status=${status}`);
  console.log(`  type: a2a:agent:${delegator} → agent:${delegatee}`);
  console.log(`  content: 【第${round}轮】${summary}`);
}
const taskText = `${TASK.title}\n${TASK.description}`;
console.log('=== 看板 A2A 团队任务真跑（真实 glm-5.3，走 /api/llm/chat 代理）===');
console.log(`任务：${TASK.title}  Leader=${LEADER} 成员=${MEMBER}\n`);

const instr = await chat([
  { role: 'system', content: `你是团队 leader(${LEADER})，把任务下发给成员 ${MEMBER}。只输出下发指令+验收标准，80字内。` },
  { role: 'user', content: `任务：\n${taskText}` },
]);
pushEvent(LEADER, MEMBER, 1, 'submitted', `Leader 下发：${instr.replace(/\n/g,' ').slice(0,80)}`);

let verdict = '', approved = false, deliverable = '';
for (let round = 1; round <= 2 && !approved; round++) {
  const em = [
    { role: 'system', content: `你是成员(${MEMBER})，按 leader 指令产出真实成果，直接给结果，30字内。` },
    { role: 'user', content: `Leader 指令：\n${instr}\n\n原任务：\n${taskText}` },
  ];
  if (verdict) em.push({ role: 'user', content: `上一轮被打回：${verdict}\n请修订。` });
  deliverable = await chat(em);
  pushEvent(MEMBER, LEADER, round, 'working', `成员回交产出：${deliverable.replace(/\n/g,' ').slice(0,80)}`);

  const rev = await chat([
    { role: 'system', content: `你是 leader(${LEADER})，审阅成员产出。第一行只输出 PASS 或 REWORK；第二行给理由。` },
    { role: 'user', content: `原任务：\n${taskText}\n\n成员产出：\n${deliverable}` },
  ]);
  approved = rev.trim().split('\n')[0].toUpperCase().includes('PASS');
  verdict = rev.trim();
  pushEvent(LEADER, MEMBER, round, approved ? 'completed' : 'input-required', `Leader 审阅：${approved?'PASS':'REWORK'} — ${verdict.replace(/\n/g,' ').slice(0,60)}`);
}
console.log(`\n=== 结果 ===`);
console.log(`workResult = 【A2A 协作${approved?'完成·Leader PASS':'未通过'}】\n${deliverable}`);
console.log(`executionEvents 共 ${events.length} 条（看板时间线会逐条显示，带 A2A 徽标 + delegator→delegatee 路由）`);
