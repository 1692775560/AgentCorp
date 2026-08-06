# 设计：真实遥测链路

## 架构

```
渲染层（编排/展示）                    主进程（采集/落库）
─────────────────────                 ─────────────────────────
pages/Evaluation (下拉选会话)
stores/evaluation.ts  ──hostApiFetch──▶ routes/evaluate.ts
services/evaluationData.ts (新客户端)     ├─ GET  /api/eval/sessions?agentId=
services/evaluationStore.ts (改客户端)    ├─ POST /api/eval/collect
services/runLinkStore.ts   (改客户端)     ├─ GET/PUT /api/eval/profiles[/:agentId]
services/telemetryCollector.ts (改客户端) └─ POST/GET /api/eval/runlinks[/:runId]
services/tokenUsageCollector.ts          services/evaluation/eval-data.ts (新)
  └ buildRoiSnapshot 纯函数保留            └ services/evaluation/eval-store.ts (新, electron-store)
```

## 主进程新模块

### `electron/services/evaluation/eval-store.ts`
- 惰性 electron-store 双实例：`agentcorp.evaluation` / `agentcorp.runlinks`（键值语义与现状完全一致，
  数据文件位置不变 <userData>/*.json，存量数据无缝衔接）。
- 导出：`saveProfile / loadProfile / listProfiles / saveRunLink / getRunLink`。

### `electron/services/evaluation/eval-data.ts`
- `listAgentSessions(agentId)`：读 `~/.openclaw/agents/<agentId>/sessions/sessions.json`
  （容忍三种 shape：数组 sessions[]、扁平 key→{sessionFile|file|sessionId|id}、key→string），
  回退 readdir 扫描 `*.jsonl`（排除 `.deleted.`），用 `extractSessionIdFromTranscriptFileName` 提取 UUID。
  返回 `[{ sessionKey, sessionId, updatedAt }]`，按 updatedAt 降序。
  agentId 校验：非空、不含 `/` `\` `..`（与 session:delete 同级防护）。
- `collectRunData({ agentId, sessionId })`：主进程版 telemetryCollector.collect + readTranscript +
  tokenUsageCollector.collectBySession/Agent，一次读取返回 `{ events, transcript, entries }`。
  逻辑直接移植自 src/services/telemetryCollector.ts（含 usage 兜底派生），依赖已有的
  `electron/utils/token-usage.ts` 与 `token-usage-core.ts`。

### 路由（追加进 `electron/api/routes/evaluate.ts`）
- `GET /api/eval/sessions?agentId=` → `{ success, sessions }`
- `POST /api/eval/collect` body `{agentId, sessionId?}` → `{ success, events, transcript, entries }`
- `GET /api/eval/profiles` → `{ success, profiles }`
- `PUT /api/eval/profiles` body=EvaluationProfile → `{ success: true }`
- `GET /api/eval/profiles/:agentId` → `{ success, profile? }`
- `POST /api/eval/runlinks` body `{runId, taskId, agentId, sessionKey, sessionId}` → `{ success, link }`（服务端填 evaluatedAt）
- `GET /api/eval/runlinks/:runId` → `{ success, link? }`

## 渲染层改动

### `src/services/evaluationData.ts`（新）
hostApiFetch 薄客户端：`listAgentSessions / collectRunData` + 类型 `AgentSessionOption / RunData`。

### `src/services/evaluationStore.ts` / `runLinkStore.ts`
改为 hostApiFetch 客户端，导出签名（save/load/list；save/getByRunId/saveForRun）不变，
删除 electron-store 动态 import。

### `src/services/telemetryCollector.ts` / `tokenUsageCollector.ts`
- 删除所有 `node:*`、`@electron/*` import。
- `telemetryCollector.ts` 已删除（无消费方；功能由 evaluationData.collectRunData 取代）。
- `tokenUsageCollector.collectBySession/collectByAgent` 委托 `collectRunData`；
  `buildRoiSnapshot` 原样保留（纯函数，测试不动）。

### `src/stores/evaluation.ts`
- runEvaluation 第 1–2 步合并为一次 `collectRunData({agentId, sessionId})`（sessionId 为空时跳过采集，
  events/entries/transcript 为空数组/空串）。
- 其余编排不变。

### `src/pages/Evaluation/index.tsx`
- runId 手填框上方加会话下拉框：`仅本地画像（不关联会话）` + `listAgentSessions(agent.id)` 结果
  （label = sessionKey 后缀或 sessionId 截断 + updatedAt 日期）。
- `handleRun`：选中会话时传真实 sessionKey/sessionId；未选时 sessionKey/sessionId 传 `''`。
- 切换 agent 时重置会话选择。

## 测试

- `tests/unit/eval-stores.test.ts`：mock 从 electron-store 改为 mock `@/lib/host-api` 的 hostApiFetch。
- `tests/unit/collectors.test.ts`：buildRoiSnapshot 部分不动（纯函数）；collect 相关 mock 改为
  mock evaluationData 客户端。
- 新增 `tests/unit/eval-routes.test.ts`：直接调用 `handleEvaluateRoutes`（mock req/res/ctx），
  用临时目录构造 sessions.json / jsonl fixture 覆盖 sessions 列举与 collect；
  profiles/runlinks 用临时 userData 路径（electron-store 的 cwd 可注入）。

## 风险

- electron-store 在 vitest(node 环境) 可 import（它是纯 Node 包，不依赖 app 只在缺省时退回 cwd），
  若不可行则在 eval-store.ts 抽象可注入的存储层，测试注入内存实现。
- sessions.json shape 与实际不符时，readdir 兜底仍能保证 sessionId 可用。
