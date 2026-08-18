/**
 * scripts/eval/squad-bench.ts
 * 多 agent 协同度量地基：固定回归集真跑 runSquadOrchestration，
 * 记录每次改动前后的「成本 × 质量」指标，让优化效果可对比、可复现。
 *
 * 运行（需 dev server 在跑，/api/llm/chat 代理已配置 LLM_API_KEY）：
 *   pnpm squad:bench            # 全部 6 题
 *   pnpm squad:bench -- research-1 code-1   # 只跑指定题
 *
 * 指标：llmCalls（成本）、耗时、交付长度、截断续写次数（finishReason=length）、
 * 各子任务通过轮数。结果 JSON 落 scripts/eval/squad-bench-results/，可 diff。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runSquadOrchestration } from '../../src/engine/squad/squadOrchestration';
import type { ChatHints, ChatMessage } from '../../src/engine/squad/squadCollaboration';
import type { RoutingCandidate } from '../../src/engine/squad/squadRouting';
import type { Team } from '../../src/types/team';

const BASE = process.env.SQUAD_BENCH_BASE ?? 'http://127.0.0.1:5173';
// 结果目录按 cwd 解析（打包后 import.meta.url 指向缓存产物，不能用）
const RESULTS_DIR = join(process.cwd(), 'scripts/eval/squad-bench-results');

// ── 固定团队：leader + 文案 / 代码 / 分析三工种成员 ──────────────
const TEAM: Team = {
  id: 'bench-team',
  name: '基准回归小队',
  leaderId: 'bench-leader',
  memberIds: ['bench-writer', 'bench-coder', 'bench-analyst'],
  description: 'squad-bench 固定回归团队',
  status: 'active',
  createdAt: 0,
  updatedAt: 0,
};

const PERSONAS: Record<string, string> = {
  'bench-leader': '你是团队负责人，擅长拆解任务、分派与审阅把关。',
  'bench-writer': '你是资深中文文案，擅长调研报告、品牌文案，表达准确有结构。',
  'bench-coder': '你是资深前端工程师，交付可直接运行的单文件代码，注释清晰。',
  'bench-analyst': '你是数据分析师，擅长资料归纳、对比表格与要点提炼。',
};

const CANDIDATES: RoutingCandidate[] = [
  { agentId: 'bench-leader', active: true, jobType: 'text', userFit: 80 },
  { agentId: 'bench-writer', active: true, jobType: 'text', userFit: 85 },
  { agentId: 'bench-coder', active: true, jobType: 'code', userFit: 85 },
  { agentId: 'bench-analyst', active: true, userFit: 75 },
];

// ── 固定回归集：调研 / 代码 / 文案各 2 题 ───────────────────────
const BENCH_TASKS: Array<{ id: string; title: string; description: string }> = [
  {
    id: 'research-1',
    title: '中国常见皮肤病调研',
    description:
      '调研中国常见皮肤病（如湿疹、痤疮、荨麻疹、银屑病）的发病情况：' +
      '流行病学数据、典型症状、常见诱因与就诊建议，输出一份结构化中文调研报告。',
  },
  {
    id: 'research-2',
    title: '新能源汽车竞品调研',
    description:
      '调研 2025 年中国 20 万元级新能源轿车市场：选 3 款代表车型，' +
      '对比售价、续航、智能化配置与销量表现，给出对比表格与选购建议。',
  },
  {
    id: 'code-1',
    title: '单文件网页计算器',
    description:
      '做一个单文件 HTML 计算器：深色主题，支持四则运算、历史记录面板、键盘输入，' +
      '代码直接可运行，保存为 .html 双击即用。',
  },
  {
    id: 'code-2',
    title: 'JS 工具函数库',
    description:
      '用 JavaScript 实现 3 个工具函数：防抖 debounce、节流 throttle、深拷贝 deepClone，' +
      '每个函数附注释与一个使用示例，放在一个可直接 node 运行的 .js 文件里。',
  },
  {
    id: 'copy-1',
    title: '待办 App 首页 Slogan',
    description: '为一款待办事项 App 写 3 条首页 Slogan 候选：中文、20 字以内、突出「随手记、不遗漏」，并各附一句创作思路。',
  },
  {
    id: 'copy-2',
    title: '智能台灯新品推文',
    description: '为一款护眼智能台灯写一条新品发布微博文案：140 字以内，含 2 个话题标签，风格温暖不硬广。',
  },
];

// ── 指标采集：包一层 chat 统计调用数与截断次数 ─────────────────
interface BenchStats {
  llmCalls: number;
  truncations: number; // finishReason === 'length' 的次数（SUMMARIZE 续写触发源）
  byAgent: Record<string, number>;
}

function makeChat(stats: BenchStats) {
  const request = async (messages: ChatMessage[], maxTokens: number) => {
    const res = await fetch(`${BASE}/api/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, maxTokens }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      content?: string;
      finishReason?: string | null;
      error?: string;
    };
    if (!res.ok || !data.content) {
      throw new Error(`LLM 代理错误 ${res.status}: ${data.error ?? JSON.stringify(data)}`);
    }
    if (data.finishReason === 'length') stats.truncations += 1;
    return data;
  };
  const chat = async (agentId: string, messages: ChatMessage[], hints?: ChatHints): Promise<string> => {
    stats.llmCalls += 1;
    stats.byAgent[agentId] = (stats.byAgent[agentId] ?? 0) + 1;
    return (await request(messages, hints?.maxTokens ?? 8192)).content!;
  };
  const chatRich = async (agentId: string, messages: ChatMessage[]) => {
    stats.llmCalls += 1;
    stats.byAgent[agentId] = (stats.byAgent[agentId] ?? 0) + 1;
    const data = await request(messages, 16384);
    return { content: data.content!, finishReason: data.finishReason ?? null };
  };
  return { chat, chatRich };
}

async function runOne(task: (typeof BENCH_TASKS)[number]) {
  const stats: BenchStats = { llmCalls: 0, truncations: 0, byAgent: {} };
  const { chat, chatRich } = makeChat(stats);
  const startedAt = Date.now();
  const result = await runSquadOrchestration({
    taskId: `bench-${task.id}`,
    taskTitle: task.title,
    taskDescription: task.description,
    team: TEAM,
    candidates: CANDIDATES,
    personas: PERSONAS,
    chat,
    chatRich,
  });
  const ms = Date.now() - startedAt;
  return {
    id: task.id,
    title: task.title,
    ms,
    llmCalls: result.llmCalls,
    truncations: stats.truncations,
    deliverableChars: result.deliverable.length,
    subtasks: result.subtasks.map((s) => ({
      title: s.title,
      assigneeId: s.assigneeId,
      rounds: s.rounds,
      outputChars: s.output?.length ?? 0,
    })),
    traces: result.traces.length,
    byAgent: stats.byAgent,
  };
}

// ── 主流程 ─────────────────────────────────────────────────────
const only = process.argv.slice(2).filter((a) => a !== '--');
const tasks = only.length > 0 ? BENCH_TASKS.filter((t) => only.includes(t.id)) : BENCH_TASKS;
if (tasks.length === 0) {
  console.error(`没有匹配的基准题。可用：${BENCH_TASKS.map((t) => t.id).join(', ')}`);
  process.exit(1);
}

console.log(`=== squad-bench：${tasks.length} 题 × 真跑（${BASE}）===\n`);
const report: { ranAt: string; base: string; results: unknown[]; failures: string[] } = {
  ranAt: new Date().toISOString(),
  base: BASE,
  results: [],
  failures: [],
};

for (const task of tasks) {
  console.log(`▶ [${task.id}] ${task.title}`);
  try {
    const r = await runOne(task);
    report.results.push(r);
    console.log(
      `  ✓ ${(r.ms / 1000).toFixed(1)}s · ${r.llmCalls} 次调用 · 交付 ${r.deliverableChars} 字 · ` +
        `截断续写 ${r.truncations} 次 · 子任务 ${r.subtasks.map((s) => `${s.title}(${s.assigneeId.replace('bench-', '')}/${s.rounds}轮)`).join('、')}\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.failures.push(`${task.id}: ${msg}`);
    console.log(`  ✗ 失败：${msg}\n`);
  }
}

mkdirSync(RESULTS_DIR, { recursive: true });
const outFile = join(RESULTS_DIR, `${report.ranAt.replace(/[:.]/g, '-')}.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`结果已写入 ${outFile}`);
if (report.failures.length > 0) process.exit(1);
