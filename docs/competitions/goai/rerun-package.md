# GOAI 复赛代码包清单（agentcorp-goai-rerun）

> SP-16：可一键运行的参赛代码包说明。对应赛题要求 6「可执行 AgentTeams 代码包（含 Demo）+ 自动化验证证据」。

## 1. 代码包结构（复赛相关路径）

```
agentcorp/
├── src/engine/agents/roleCard.ts        # Agent Identity 清单（附录A）：4 张异构角色卡
├── src/demo/
│   ├── agentteams-adapter.ts            # AgentTeams 薄适配：ATAgent/ATTeam/ATTask/ATRun/ATSkill + invokeSkill
│   ├── closedLoop.ts                    # 八步闭环编排器（approve/precipitate 走 boss_review Skill）
│   ├── skills/
│   │   ├── registry.ts                  # Skill 注册表（GOAI 2.1 全字段 + handler）
│   │   ├── handlers.ts                  # 5 个内建 Skill handler（含失败降级）
│   │   └── experienceStore.ts           # 经验沉淀 Store（沉淀→复用注入回路）
│   ├── observability/
│   │   ├── otelGenai.ts                 # OTel GenAI 语义映射（gen_ai.* 字段）
│   │   └── traceSink.ts                 # Trace 落盘（JSONL）+ 回放
│   ├── ClosedLoopDemo.tsx               # Demo 页（Team→Task→Run，Agent→Skill 调用链可视化）
│   ├── liveJudge.ts / mockJudge.ts      # 真实评委 / 确定性 mock（离线可跑）
│   └── main.tsx
├── demo.html                            # Demo 入口（/demo.html）
├── tests/unit/                          # 7 个 GOAI 专项测试文件（40+ 断言）
├── scripts/qa/goai-verify.mjs           # 自动化验证报告脚本
├── scripts/privacy-grep.sh              # 隐私 grep 门禁
└── docs/artifacts/
    ├── mcp-equivalent-contract.md       # MCP 等价契约（要求 3）
    ├── goai-verification-report.md      # 自动化验证报告（要求 6，pnpm verify:goai 生成）
    └── goai-rerun-package.md            # 本文件
```

## 2. 一键运行步骤

```bash
pnpm install            # 依赖安装（pnpm 10.31.0，可用 corepack pnpm）
pnpm web                # 起 web 预览（端口 5174）
# 浏览器打开 http://localhost:5174/demo.html → 点「▶ 运行 AgentTeams 闭环」
pnpm verify:goai        # 自动化验证：tsc + 7 个专项测试 + 隐私 grep → 生成验证报告
pnpm privacy:check      # 单独跑隐私门禁
```

Demo 页可验证的评审要点：
- Agent Identity 清单（4 异构 Agent + 能力边界 + Skills）
- 步骤面板的「Agent →⚙ Skill」调用链（recruiter→agent_interview、evaluator→capability_assessment/reliability_audit、boss→boss_review）
- 八步闭环 trace、pass^k、偏差审计、老板拍板（rollback 需人工确认）
- 「保存本次 Trace」下载 run-*.jsonl；「回放历史 run」还原历史执行

## 3. 门禁命令（交付前逐条过）

| 门禁 | 命令 | 通过线 |
|---|---|---|
| 类型 | `pnpm typecheck` | 0 error |
| 单测 | `pnpm vitest run --pool=threads` | 全绿（500+） |
| Lint | `pnpm lint:check` | 0 error |
| GOAI 专项 | `pnpm verify:goai` | 总结论 PASS |
| 隐私 | `pnpm privacy:check` | 零命中 |

## 4. 隐私声明

参赛包不包含：`docs/review/` 原始本机路径版本、`node_modules`、`.git`、任何含用户名/本机绝对路径/AI 工具目录的文件。提交前 `pnpm privacy:check` 必须零命中（命中即 exit 1）。

## 5. 不包含项（产品侧负责）

- 更新版 PPT（SP-19）：需补 Demo 截图（`goai-demo-screenshot.png`，SP-15）、Trace 回放页、Metrics 页、验证证据页。
