#!/usr/bin/env node
/**
 * GOAI 复赛自动化验证报告脚本（SP-14）
 * 依次执行代码门禁与 GOAI 专项测试，汇总生成
 * docs/artifacts/goai-verification-report.md（含命令、通过数、门禁结论）。
 * 用法：node scripts/qa/goai-verify.mjs  （或 pnpm verify:goai）
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const reportPath = join(root, 'docs/artifacts/goai-verification-report.md');

/**
 * 输出脱敏（QA 复核修复）：报告落在 privacy:check 的扫描目录内，
 * 原始命令输出可能含本机绝对路径（pnpm 打印 cwd）或 grep 命中的受限 token
 * （FAIL 路径会把命中行带进来，造成递归自命中 + 报告本身成为泄漏载体）。
 * 一律先脱敏再落盘。
 */
const PRIVACY_RE = /陈思丞|C:[/\\]Users|\/c\/Users|\.workbuddy|\.trae|\/Users\/[^\s]*|\/home\/[^\s]*/g;
function sanitize(text) {
  return text.split(root).join('<repo>').replace(PRIVACY_RE, '<redacted>');
}

const env = { ...process.env };
delete env.NODE_OPTIONS; // 规避沙箱/代理注入的 NODE_OPTIONS 干扰

/** 顺序执行的门禁步骤 */
const steps = [
  {
    name: 'typecheck（tsc --noEmit 双 tsconfig）',
    cmd: 'corepack',
    args: ['pnpm', 'typecheck'],
  },
  {
    name: 'GOAI 专项测试（adapter/closedLoop/skills/otel/trace-sink）',
    cmd: 'corepack',
    args: [
      'pnpm',
      'vitest',
      'run',
      '--pool=threads',
      'tests/unit/agentteams-adapter.test.ts',
      'tests/unit/closedLoop.test.ts',
      'tests/unit/skills-registry.test.ts',
      'tests/unit/skills-handlers.test.ts',
      'tests/unit/skills-experience.test.ts',
      'tests/unit/otel-genai.test.ts',
      'tests/unit/trace-sink.test.ts',
    ],
  },
  {
    name: '隐私 grep（privacy:check）',
    cmd: 'corepack',
    args: ['pnpm', 'privacy:check'],
  },
];

const results = [];
let allPass = true;

for (const step of steps) {
  const startedAt = Date.now();
  let status = 'PASS';
  let tail = '';
  try {
    const out = execFileSync(step.cmd, step.args, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    });
    tail = sanitize(out.trim().split('\n').slice(-6).join('\n'));
  } catch (err) {
    status = 'FAIL';
    allPass = false;
    const out = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim();
    tail = sanitize(out.split('\n').slice(-12).join('\n'));
  }
  // 提取测试通过数（vitest 输出形如 "Tests  40 passed (40)"）
  const m = tail.match(/Tests\s+(\d+) passed/);
  results.push({
    name: step.name,
    command: `${step.cmd} ${step.args.join(' ')}`,
    status,
    durationMs: Date.now() - startedAt,
    testsPassed: m ? Number(m[1]) : null,
    tail,
  });
  console.log(`[${status}] ${step.name} (${results.at(-1).durationMs}ms)`);
}

const now = new Date().toISOString();
const lines = [
  '# GOAI 复赛自动化验证报告',
  '',
  `生成时间：${now}（由 \`pnpm verify:goai\` 自动生成，勿手改）`,
  '',
  '| 门禁步骤 | 命令 | 结果 | 耗时 |',
  '|---|---|---|---|',
  ...results.map(
    (r) =>
      `| ${r.name} | \`${r.command}\` | ${r.status === 'PASS' ? '✅ PASS' : '❌ FAIL'} | ${(r.durationMs / 1000).toFixed(1)}s |`,
  ),
  '',
  `**总结论：${allPass ? '✅ PASS（全部门禁通过）' : '❌ FAIL（存在未过门禁）'}**`,
  '',
  '## 关键输出摘录',
  '',
  ...results.flatMap((r) => [
    `### ${r.name}`,
    '',
    '```',
    r.tail || '(no output)',
    '```',
    '',
  ]),
];

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, lines.join('\n'));
console.log(`报告已生成：${reportPath}`);
console.log(`总结论：${allPass ? 'PASS' : 'FAIL'}`);
process.exit(allPass ? 0 : 1);
