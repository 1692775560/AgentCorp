# PRD：接通真实遥测链路（runId 去伪 + sessionId 修正 + 采集迁主进程）

## 背景

评审发现评估中心（/evaluation）的"真实遥测"链路是断的：

1. **H3 进程错位**：`telemetryCollector` / `tokenUsageCollector` / `evaluationStore` / `runLinkStore`
   在渲染层 import `node:fs` / `electron-store`，而主窗口 `contextIsolation: true, nodeIntegration: false`，
   真机上必然运行失败——评估页当前在真实 Electron 里不可用。
2. **M1 sessionKey/sessionId 混用**：`pages/Evaluation/index.tsx` 把 `agent.mainSessionKey`
   （形如 `agent:<id>:main`）同时塞进 sessionKey 和 sessionId，而转录文件名是 session UUID，
   `resolveTranscriptPath` 永远 miss → 兜底派生全优假 KPI。
3. **H4 runId 假接线**：runId 靠用户手填，且 `taskId` 恒为 `''`，runlink 只写脏数据。

## 目标

评估页在真实 Electron 中可用：用户从下拉框选择 agent 的真实会话（含真实 sessionId），
评估编排使用真实遥测/用量/转录；采集与落库全部在主进程完成，渲染层只做编排与展示。

## 范围（In Scope）

1. 主进程 Host API 新增评估数据端点（扩展 `electron/api/routes/evaluate.ts`）：
   - `GET /api/eval/sessions?agentId=` — 列出 agent 的真实会话（sessionKey + sessionId(UUID) + updatedAt）。
   - `POST /api/eval/collect` — 一次返回 `{ events, transcript, entries }`（遥测 + 转录 + token 用量）。
   - `GET /api/eval/profiles` / `PUT /api/eval/profiles` / `GET /api/eval/profiles/:agentId` — 评估档案 CRUD（electron-store 在主进程）。
   - `POST /api/eval/runlinks` / `GET /api/eval/runlinks/:runId` — runlink 读写。
2. 渲染层四个服务改为 Host API 客户端（导出签名不变）：`evaluationStore` / `runLinkStore` /
   `telemetryCollector` / `tokenUsageCollector`（`buildRoiSnapshot` 纯函数保留）。
3. 评估页：runId 手填框 → 会话下拉框（"仅本地画像" + 真实会话列表）；选中后
   sessionKey/sessionId 用真实值。runId 输入保留为可选高级项（诚实标注：自动捕获 chat.send
   返回值是后续任务）。
4. `stores/evaluation.ts`：`collect` + `readTranscript` 两次读文件合并为一次 `collectRunData` 调用。
5. 测试：更新 eval-stores / collectors 两个测试的 mock 层；新增主进程路由测试。

## 非目标（Out of Scope）

- runId 从 `chat.send` 返回值自动捕获（后续任务，依赖评估触发改到聊天链路）。
- 语音闭环（narration/audio SSE 消费）。
- Mock 遥测的"全优"兜底逻辑改造（collect 找不到转录时仍回退 usage 派生，行为不变）。

## 验收标准

- `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿。
- 渲染层 `src/services/` 不再 import `node:*` / `electron-store` / `@electron/*`。
- 主进程路由测试覆盖：sessions 列举（sessions.json 三种 shape）、collect（有/无转录）、profiles CRUD、runlinks 读写。
- 评估页选择真实会话后，`runEvaluation` 使用真实 sessionId（代码走查 + 单测）。
