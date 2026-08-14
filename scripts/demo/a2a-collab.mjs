/**
 * scripts/demo/a2a-collab.mjs
 * 真实多 Agent（A2A）协作协议演示 —— 直连真实 LLM（火山方舟 glm-5.3）。
 *
 * 这不是 mock：leader 与成员是两个真实 LLM 会话，消息按 A2A 协议在它们之间
 * 来回传递（DELEGATE → EXECUTE → REVIEW，打回则返工再来一轮）。每条 agent 间
 * 消息都打印为一条 A2A trace（与 src/engine/squad/squadCollaboration.ts 同协议）。
 *
 * 读取 .env 的 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL。
 * 运行：node scripts/demo/a2a-collab.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// —— 读 .env ——
function loadEnv() {
  const env = {};
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  } catch { /* ignore */ }
  return env;
}
const env = loadEnv();
const API_KEY = process.env.LLM_API_KEY || env.LLM_API_KEY;
const BASE_URL = (process.env.LLM_BASE_URL || env.LLM_BASE_URL || '').replace(/\/$/, '');
const MODEL = process.env.LLM_MODEL || env.LLM_MODEL;

if (!API_KEY || !BASE_URL || !MODEL) {
  console.error('缺少 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL（见 .env）');
  process.exit(1);
}

// —— 真实 LLM 调用（每个 agent 一次真实请求）——
async function chat(agentId, messages) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 2048, stream: false }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  const msg = json.choices?.[0]?.message;
  return (msg?.content?.trim() || msg?.reasoning_content?.trim() || '').trim();
}

// —— A2A trace 打印 ——
let n = 0;
function trace({ delegator, delegatee, round, state, summary, reworkOf }) {
  n += 1;
  const arrow = `${delegator}  ──▶  ${delegatee}`;
  console.log(`\n[A2A #${n}] round=${round} state=${state}${reworkOf ? ` rework_of=${reworkOf}` : ''}`);
  console.log(`  ${arrow}  (channel=internal-rpc, kind=message)`);
  console.log(`  summary: ${summary}`);
}

const LEADER = 'leader-01';
const MEMBER = 'member-coder-01';
const TASK = {
  title: '实现一个 JS 函数 slugify(str)',
  description: '把中文/英文标题转成 URL slug：小写、空格转连字符、去除特殊符号。给出函数 + 2 个示例。',
};

async function main() {
  console.log('==============================================');
  console.log(' 真实多 Agent A2A 协作协议演示（真实 glm-5.3）');
  console.log(` 任务：${TASK.title}`);
  console.log(` Leader=${LEADER}  成员=${MEMBER}`);
  console.log('==============================================');

  const taskText = `${TASK.title}\n${TASK.description}`;

  // 1. DELEGATE：leader → 成员
  const instruction = await chat(LEADER, [
    { role: 'system', content: `你是团队 leader(${LEADER})，把任务下发给成员 ${MEMBER}。只输出下发指令+验收标准，不要自己做。120字内。` },
    { role: 'user', content: `任务：\n${taskText}` },
  ]);
  trace({ delegator: `agent:${LEADER}`, delegatee: `agent:${MEMBER}`, round: 1, state: 'submitted', summary: instruction.replace(/\n/g, ' ').slice(0, 120) });
  console.log(`  ┗━ Leader 真实下发全文：\n     ${instruction.replace(/\n/g, '\n     ')}`);

  let verdict = '';
  let approved = false;
  let deliverable = '';
  const maxRounds = 2;

  for (let round = 1; round <= maxRounds; round++) {
    // 2. EXECUTE：成员 → leader
    const execMsgs = [
      { role: 'system', content: `你是执行成员(${MEMBER})，按 leader 指令产出真实成果，直接给结果。200字内。` },
      { role: 'user', content: `Leader 指令：\n${instruction}\n\n原任务：\n${taskText}` },
    ];
    if (verdict) execMsgs.push({ role: 'user', content: `上一轮被打回，意见：\n${verdict}\n请修订。` });
    deliverable = await chat(MEMBER, execMsgs);
    trace({ delegator: `agent:${MEMBER}`, delegatee: `agent:${LEADER}`, round, state: 'working', summary: `成员回交产出（第${round}轮）：${deliverable.replace(/\n/g, ' ').slice(0, 100)}` });
    console.log(`  ┗━ 成员真实产出全文：\n     ${deliverable.replace(/\n/g, '\n     ')}`);

    // 3. REVIEW：leader 审阅
    const review = await chat(LEADER, [
      { role: 'system', content: `你是 leader(${LEADER})，审阅成员产出。第一行只输出 PASS 或 REWORK；第二行起给理由/修改意见。` },
      { role: 'user', content: `原任务：\n${taskText}\n\n成员产出：\n${deliverable}` },
    ]);
    approved = review.trim().split('\n')[0].toUpperCase().includes('PASS');
    verdict = review.trim();
    trace({ delegator: `agent:${LEADER}`, delegatee: `agent:${MEMBER}`, round, state: approved ? 'completed' : 'input-required', summary: `Leader 审阅：${approved ? 'PASS' : 'REWORK'} — ${verdict.replace(/\n/g, ' ').slice(0, 60)}`, reworkOf: approved ? null : `round${round}` });
    console.log(`  ┗━ Leader 真实审阅全文：\n     ${verdict.replace(/\n/g, '\n     ')}`);

    if (approved) break;
  }

  console.log('\n==============================================');
  console.log(` 协议结束：${approved ? '✅ Leader 通过（PASS）' : '⚠️ 达到最大轮次仍未通过'}`);
  console.log(` 总 A2A 消息数=${n}  真实往返轮次=${maxRounds >= 1 ? (approved ? '至通过' : maxRounds) : 0}`);
  console.log('==============================================');
}

main().catch((e) => { console.error('演示失败：', e.message); process.exit(1); });
