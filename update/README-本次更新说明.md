# 本次更新说明（2026-08-15 第二轮）

> 本文件夹是**供你下载审阅、再自行上传 GitHub 的汇总包**。
> 所有内容均已同时落在仓库对应位置，此处是副本便于集中查阅。
>
> ⚠️ 注意：`update/` 只是审阅副本。**真正生效的是仓库里的原路径文件**，
> 上传时请以仓库结构为准，不要把 `update/` 目录本身当成代码目录提交
> （建议合并后删除，或加进 `.gitignore`）。

---

## 一、验证结果（全部实跑，非声称）

| 门禁 | 命令 | 改动前 | 改动后 |
|---|---|---|---|
| 前端单测 | `pnpm test` | 633 passed | **654 passed** |
| GOAI 专项 | `pnpm verify:goai` | 45 passed / 7 文件 | **66 passed / 9 文件** |
| 模型服务 | `pytest tests/ -q` | 271 passed（需手动补 httpx） | **271 passed**（一键装齐） |
| 类型 | `tsc --noEmit` ×2 | 0 error | **0 error** |
| Lint | `eslint .` | 0 error / 50 warn | **0 error / 50 warn** |
| 隐私 | `pnpm privacy:check` | CLEAN | **CLEAN** |
| 总门禁 | `pnpm verify:goai` | PASS | **PASS** |

> `tests/unit/collectors.test.ts` 在沙箱内因缺 Electron 二进制而 fail —— 环境问题，非代码缺陷。

---

## 二、目录说明

```
update/
├── README-本次更新说明.md          ← 你正在看的文件
├── 01-赛事文档/                    ← 新增/更新的分析与方案文档
│   ├── 00-赛事材料规则-README.md        多赛事中立性规则（应对阿里/华为/未来任意赛事）
│   ├── 初赛-代码审阅与提交方案.md        主报告（含风险状态更新 + 作品简介 + 16页PPT设计）
│   ├── 方法论评估-评测体系是否站得住.md   pass^k/α/偏差审计的方法论辩护 + 三个自曝漏洞
│   ├── 双轨定位-企业治理与个人工作流.md   企业 + 个人如何统一叙事
│   ├── 多Agent系统-统一叙事与超额完成清单.md  两套系统怎么合 + 本次交付清单
│   ├── verification-report.md           自动化验证报告（已重新生成）
│   └── rerun-package.md                 代码包清单
├── 02-新增代码/
│   ├── governance/approvalGate.ts       ★ 审批门 + Saga 回滚执行器 + 审计流水
│   ├── agentteams/hiclawCrd.ts          ★ HiClaw/AgentTeams CRD 导出器
│   ├── scripts/export-hiclaw.mjs        导出命令实现
│   └── requirements-dev.txt             模型服务测试依赖（修 httpx 问题）
├── 03-新增测试/
│   ├── approval-gate.test.ts            14 项，断言「动作真的没执行」
│   └── hiclaw-crd.test.ts               7 项，断言 CRD 映射结构正确
├── 04-产物/
│   ├── hiclaw-manifest.yaml             ★ 自动导出的 HiClaw CRD 清单（可直接给评委看）
│   └── mcp-equivalent-contract.md       MCP 口径已更正为「已接入 + 等价契约」双层
└── 05-修改的文件/                   ← 按原路径组织，便于比对
```

---

## 三、五件核心改动

### 1. 审批门与回滚执行器（把「标签」变成「门」）

**文件**：`src/demo/governance/approvalGate.ts`（新增，约 400 行）

此前 `boss_review` 只产出 `{action:'rollback', requiresHumanAck:true}` 这样的**标签**，
全仓没有任何代码消费它——高风险动作照样执行到底。现在：

- 高风险动作**不执行**，落 PENDING 审批单，闭环挂起为 `awaiting_approval`
- 人类 `approve` 之后动作才真正执行；`reject` 则永不执行
- 幂等保护：已决策单拒绝重复决策（防高风险动作被重放执行两次）
- Saga 补偿模式回滚：**逆序**撤销已执行动作
- **半回滚状态如实暴露**（单条补偿失败不吞掉，进 `failures`）
- 不可补偿动作显式标注，不假装回滚成功
- 每次状态跃迁留不可变审计条目，可导出 JSONL

**实跑证据**：
```
STATUS: awaiting_approval | pendingApprovalId: appr-msv161t4-rkio5a
  approve  blocked  老板决策：HIRE…（⛔ 已被审批门拦截，动作未执行，等待人工放行）
录用台账（应为空，因为未放行）: []
```

Demo UI 已接入：橙色审批卡片 + 放行/拒绝按钮 + 实时台账计数 + 审计流水面板。

### 2. HiClaw / AgentTeams CRD 导出（把「类型同形」变成「可核对产物」）

**文件**：`src/demo/agentteams/hiclawCrd.ts` + `scripts/agentteams/export-hiclaw.mjs`
**命令**：`pnpm agentteams:export`
**产物**：`docs/artifacts/hiclaw-manifest.yaml`（5 个 CRD 文档，已验证合法 YAML）

4 张角色卡 → HiClaw 真实 CRD（`hiclaw.io/v1beta1`）：
`boss→TeamAdmin`（平台管控）、`dispatcher→TeamLeader`（业务协作）、
`recruiter/evaluator→Worker`（执行层）。附通信底座（→Matrix）与凭证托管
（→Higress Consumer Token）对照声明，以及**六项迁移成本矩阵**
（五项协议适配/配置替换，仅控制面 reconcile 需新增工程）。

产物里写死诚实边界「尚未在 HiClaw 控制面真实 reconcile」，并有测试断言这句话必须在。

### 3. 多赛事中立化

**问题**：仓库里到处是「华为昇腾挑战赛项目」，拿去投阿里观感灾难。

**做法**（不是删干净，是建立规则）：
- 新增 `docs/competitions/README.md`：中立性规则 + 检查清单 + ❌/✅ 表述对照表
- 赛事材料收敛到 `docs/competitions/<赛事>/`；昇腾 PRD 归档到 `_archive-ascend/` 并加醒目免责横幅
- README §4 重写为**四条路径**，默认改为「任意 OpenAI 兼容云服务」（零硬件门槛），
  异构加速卡降级为可选后端之一
- 22 处代码注释去品牌化（`judge_backend.py` / `model_loader.py` / `config.py` 等）
- **关键论证**：裁判后端不绑定单一模型家族，不只是为参赛方便——
  这是缓解**自我增强偏差**的架构级手段。**赛事中立 = 技术正确。**

### 4. MCP 口径更正

契约文档原写「AgentCorp 未直接接入 MCP」——**与代码不符**。
实际 `electron/services/mcp/runtime-manager.ts`（453 行）是完整 MCP 客户端：
stdio / SSE / StreamableHTTP 三 transport、tools/list、tools/call、
生命周期管理、环形日志、并发去重、启动时注入 agent。

已改为双层口径：**① 已接入 MCP 客户端运行时（消费外部工具）
② Host API 等价契约（发布自身能力为 MCP Server 是复赛项）**。

### 5. 依赖与卫生修复

- `@modelcontextprotocol/sdk@^1.27.1` 显式入 `package.json`
  （此前靠 openclaw 传递依赖 + `shamefully-hoist` 侥幸编译，评委 clone 后可能直接挂）
- 新增 `model-service/requirements-dev.txt`（`httpx<0.28`），CI 同步
  （此前 `pip install -r requirements.txt && pytest` 会 4 个文件收集失败）
- 删除 `orchestrate` 虚假 Skill 标签（trace 打了标签但从未调用）
- 经验沉淀 localStorage 持久化（此前刷新页面即丢，演示会翻车）
- 删除 `.trellis/` `.agents/` `.kimi-code/` `AGENTS.md`（189 文件）
  —— **删除前已验证零代码/配置引用，删除后 654 测试全绿**

---

## 四、仍待处理

| 项 | 说明 |
|---|---|
| Playwright 截图 | 版本错配（`@playwright/test` 1.62.0 vs `playwright` 1.62.1）+ 沙箱无 chromium 系统依赖；需在有 GUI 的环境重出 `goai-demo-screenshot.png`。另 e2e 断言需同步审批门新文案（现在会停在 `awaiting_approval`） |
| PPT | 16 页结构见主报告第 4 部分；建议新增「审批门现场演示」一页 |
| 作品简介 | 主报告第 3 部分有 468 字草稿，建议按双轨定位微调一句 |
| 治理层 × 执行层真实串联 | 架构已对齐（同一套 RoleCard + Trace schema），初赛诚实标注为复赛项即可 |
| posthog 遥测说明 | README 补一句「可关闭」，企业场景必被问 |

---

## 五、新增可用命令

```bash
pnpm agentteams:export   # 导出 HiClaw CRD 清单 + 打印迁移成本矩阵
pnpm verify:goai         # 三门禁（typecheck / 9 个 GOAI 专项测试文件 / 隐私 grep）

# 模型服务测试（现在一键装齐，不用手动补 httpx）
cd model-service && pip install -r requirements.txt -r requirements-dev.txt && MOCK=true pytest tests/ -q
```
