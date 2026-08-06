# implement.md — A2A 通信集成设计

## 结果

产出 `docs/a2a-integration.md`（约 30KB，中文），纯设计文档，未改任何代码。

## 文档章节结构

1. **A2A 协议现状调研**（WebSearch/FetchURL 调研，全部附链接）：spec v1.0.0（2026-03-12）/ v1.0.1（2026-05）；2025-06-23 捐给 Linux Foundation（TSC 含 AWS/Google/Microsoft/SAP 等）；核心概念（AgentCard v1.0 字段、`/.well-known/agent-card.json`、8 态 Task 状态机、Message/Part/Artifact、JSON-RPC+gRPC+REST 三绑定、SSE/webhook 更新机制）；与 MCP 官方分工（A2A=agent↔agent，MCP=agent→tool）；SDK 选型 `@a2a-js/sdk@1.0.1` / Python `a2a-sdk@1.1.2`；安全（Bearer/OAuth2/mTLS、AgentCard JWS 签名）；0.2→0.3→1.0 破坏性变更清单。
2. **现状映射**：六层私有协议逐项给出文件+行号依据——gateway WS JSON-RPC（`electron/gateway/protocol.ts`、`ws-client.ts:187-213`、`manager.ts:619`）、Host API session token（`electron/api/server.ts:58-101`）、leader→worker 委派（SOUL.md 提示词约定 `team-config.ts:208` + `chat.send` RPC `session-runtime-manager.ts:135-198`）、市集 hire（IDENTITY.md 正则解析 `openclaw-workspace.ts:347-383`、hireSingle/hireTeam `:468-707`）、评估证据链（`eval-data.ts:213-277`，rework/escalations 硬编码 0 的硬伤）、toolPolicy 失效（`config-sync.ts:288-297` 被注释、`openclaw-auth.ts:940-952` sanitize 剥离）。附「能力 → 私有协议 → A2A 对应物」汇总表。
3. **集成设计**：
   - 分层：内部链路（Electron↔gateway、leader→worker、Host API）全保留私有协议；仅跨信任边界（外部 agent 被 hire / AgentCorp agent 被外部雇佣）升级 A2A；Adapter 放 Electron 主进程，不进 gateway 子进程。
   - AgentCard 映射表：IDENTITY.md Name→name、Role→description、AGENTS.md capabilities→skills、teamRole→团队卡结构等，逐字段给出数据来源行号；rating/hiredCount 不映射（现为随机数 `openclaw-workspace.ts:449-450`）。
   - endpoint：`/.well-known/agent-card.json` + `POST /a2a`（JSON-RPC binding）挂在 Host API server；鉴权用**独立 A2A Bearer token**（不复用 per-session host token），按雇主签发/可吊销，仍绑 127.0.0.1。
   - **A2A trace 作为评估证据（核心独特点）**：定义 JSONL trace schema（trace_id/parent_task_id/delegator/delegatee/round/state/rework_of/channel/耗时），落盘 `~/.openclaw/a2a-traces/`；内部委派（SessionRuntimeManager 埋点）与真 A2A 链路写同一 schema；`collectRunData` 从 trace 客观计算 rework/first_try/escalations/human_interventions/latency，替代 transcript 间接推断；trace 摘要进 MiniCPM-o judge prompt，evidence_trace 可回放到具体 trace_id。
   - 昇腾关系：trace 为结构化短文本进 judge prompt；Mock 路径可先行消费合成 trace，P1 不依赖 NPU。
4. **分阶段计划**：P1 trace 采集进评估 → P2 AgentCard + A2A endpoint（server 角色）→ P3 市集外部 agent hire（client 角色）→ P4 昇腾真机联调。每阶段列了验收标准与改动文件预估，均可独立演示。
5. **风险与边界**：版本漂移（锁 v1.0 + A2A-Version 头）、gateway 进程边界（A2A 不进 gateway 进程）、安全（外部 agent 不可信输入 + toolPolicy 失效是 P3 硬前置，推荐 Adapter 层自建沙箱方案 b）、明确不做的范围（联邦目录、webhook、改 gateway 本体、完整 PKI）。

## 调研方式与依据

- 协议事实由 explore 子代理经 WebSearch/FetchURL 核实，来源为 a2a-protocol.org、github.com/a2aproject（A2A releases、a2a-js、a2a-python）、Linux Foundation 新闻稿、Google/Microsoft 官方博客，链接全部写入文档「附：主要参考来源」。
- 仓库现状论断均有 `文件:行号`，来自实读：team-config.ts、openclaw-workspace.ts、sessions.ts、session-runtime-manager.ts、eval-data.ts、evaluation.ts、server.ts、evaluate.ts、config-sync.ts、openclaw-auth.ts、protocol.ts、ws-client.ts、manager.ts、evaluator.py、model_loader.py、routes/evaluate.py 及 PRD-AgentCorp.md / ascend-adaptation-plan.md。

## 关键设计决策

1. **直接瞄准 A2A v1.0**，跳过 0.x（1.0 已多处 break 0.x 且无 LTS）。
2. **A2A Adapter 放 Electron 主进程**，不侵入 OpenClaw gateway 子进程（帧私有、版本不受控）。
3. **内部委派保留 `chat.send` 私有 RPC**，只加 A2A 语义 trace 埋点——P1 即可交付评估价值，不等 A2A wire。
4. **A2A token 独立于 Host API session token**（后者每次启动随机重生、只给 renderer）。
5. **trace-first**：把「A2A 消息日志 = 绩效证据」作为项目独特点写细，comm/rework/escalation 从 trace 客观计算。

## 验证

设计/研究任务，无代码改动，未跑测试（无测试可跑）。文档已落盘 `docs/a2a-integration.md`（Write 成功，30559 字节）。

## 遗留

- 未 git commit / push（按要求；archive 脚本 auto-commit 除外）。
- P3 硬前置：toolPolicy 沙箱方案（恢复 syncToolPolicyToConfig 或 Adapter 层自建沙箱）需单独立项。
- 模板目录缺版本号，AgentCard `version` 暂固定 0.1.0。
