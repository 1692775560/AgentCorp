# MCP 等价契约（MCP-Equivalent Contract）

> GOAI 复赛要求 3（SP-12）：AgentCorp 未直接接入 MCP，本文件即**等价集成契约**——
> Electron Host API（`:3210`）+ OpenClaw gateway（`:18789` WS）以 REST + RPC 形态
> 暴露 agent 可调用的全部工具面。迁移到真 MCP = 把下表每个 tool 包成 MCP `tool`
> schema（协议适配），调用链与鉴权不变（见文末迁移步骤）。

## 0. 传输与鉴权

| 项 | 值 |
|---|---|
| Host API | `http://127.0.0.1:3210`（Electron 主进程，`electron/api/server.ts`） |
| Gateway | `ws://127.0.0.1:18789`（OpenClaw，RPC 帧 `{type,id,method,params}`） |
| Model Service | `http://127.0.0.1:8000`（Python 评分/评委后端） |
| 鉴权 | Host API 请求头 `x-clawx-host-session: <token>`（`electron/api/route-utils.ts` 的 `HOST_API_SESSION_HEADER`；未授权一律 401） |
| 错误约定 | `{ success: false, error: string }`；未匹配路由 404 `No route for <METHOD> <path>` |
| 幂等/审计 | 写操作（arena user-pick、agents 写、委派）均落盘/留痕；A2A 委派写 `~/.openclaw/a2a-traces/*.jsonl`（见 SP-11 字段映射） |

## 1. Tool Schema 清单

### tool: `evaluate.run` — SSE 评分流

- `POST /api/evaluate/run`（`electron/api/routes/evaluate.ts`）
- **params**：`{ agentId, transcript, k?, threshold?, bossProfile? }`
- **returns**：SSE 事件流——`narration`（讲解）/ `audio`（语音）/ `score`（逐维雷达）/ `verdict`（宣判 MVP/OBSERVE/FIRED）/ `done`
- **errors**：`400` 参数缺失；`502` model-service 不可达（调用方应降级 mock，见 `src/demo/liveJudge.ts`）

### tool: `judge.chat` — 单轮 LLM 评委

- `POST /api/chat-judge`
- **params**：`{ messages: [{role, content}], rubricVariant? }`（`rubricVariant` 驱动维度顺序旋转去位置偏差）
- **returns**：`{ radar: RadarScore, verdict, confidence, evidence[] }`
- **errors**：judge 超时/解析失败 → 调用方按 `null` 处理并降级（见 `src/demo/skills/handlers.ts` capability_assessment 的 degraded 约定）

### tool: `craft.judge` — 试做题客观分

- `POST /api/craft-judge`（`electron/api/routes/craft.ts`）
- **params**：`{ taskId, submission, files? }`
- **returns**：`{ craftScore, rubric[], objectiveChecks[] }`（客观检查 + 评委分双轨）

### tool: `arena.compare` / `arena.userPick` — 双轨竞技场

- `POST /api/arena/compare`（params: `{ prompt, candidates[] }` → returns: 各候选回答 + 客观分）
- `POST /api/arena/user-pick`（params: `{ comparisonId, winnerId }` → returns: Elo 更新后排行榜快照；写操作，落盘留痕）

### tool: `agents.*` — 数字员工 CRUD（System of Record 雏形）

- `GET /api/agents` / `POST /api/agents` / `PATCH /api/agents/:id` / `DELETE /api/agents/:id`
- **returns**：`AgentSummary`（persona/teamRole/reportsTo/生命周期状态）

### tool: `eval.*` — 评估数据中心

- `GET /api/eval/sessions`（评估会话列表）· `GET /api/eval/profiles`（EvaluationProfile）· `POST /api/eval/collect`（从 run trace 采集评估数据）· `GET /api/eval/runlinks`（runId↔task 关联）

### tool: `gateway.*` — 运行时管控

- `GET /api/gateway/status|health` · `POST /api/gateway/start|stop|restart`（OpenClaw 进程生命周期）

## 2. 迁移到真 MCP 的逐 tool 适配步骤

1. 为上表每个 tool 定义 MCP `Tool` schema：`name` 用上表 tool 名，`inputSchema` 由 params 直译（JSON Schema），`description` 取本表用途行。
2. MCP server 的 `tools/call` handler 内：把 `arguments` 原样转发为对应 REST 调用（Host API 加 `x-clawx-host-session` 头；gateway 方法走 WS RPC 帧）。
3. SSE 类 tool（`evaluate.run`）在 MCP 侧映射为 `notifications/progress` + 最终 resource；其余 JSON 响应直接作为 `content` 返回。
4. 鉴权迁移：MCP server 启动时注入同一 session token（环境变量），客户端无感。
5. 审计不变：委派/写操作继续落 A2A trace JSONL，OTel GenAI 投影路径不变（`src/demo/observability/otelGenai.ts`）。

> 结论：迁移成本 = 协议适配层（schema 直译 + 传输封装），**零业务逻辑改动**。
