# AgentCorp API 接口契约文档

接口契约的唯一真相源。前端与服务端实现均以本文件为准。

## 0. 总览与约定

- **两条服务**：
  - **model-service**（FastAPI，端口 `API_PORT` 默认 8000）：评测/评分/裁判逻辑，`model-service/app/serve.py` 装配路由。
  - **Host API**（Electron 主进程，`http://127.0.0.1:3210`）：渲染层唯一访问入口；负责本地持久化（electron-store）与向 model-service 转发。
- **鉴权**：所有 Host API 请求需带 `x-clawx-host-session: <token>`（renderer 经 `ipc 'hostapi:token'` 获取，见 `src/lib/api-client.ts` / `judgeClient.ts`）。CORS 白名单 `app://.` / `null`。model-service 直连（无 Host API 时）无鉴权，仅本机回环。
- **命名**：前端 JSON 用 camelCase（Host API 转发时保持），后端 pydantic 用 AliasGenerator 兼容 snake_case/camelCase（见 `schemas.py` 的 `JudgeRunRequest` 先例）。
- **错误码语义（统一）**：
  - `400` 参数格式错误 / 业务校验失败（Host API 本地实现常用）
  - `404` 资源不存在（未知题目/agent/match/工种）
  - `409` 状态冲突（重复 pick、重复投票）
  - `422` 请求体缺必需字段 / 语义不合法（pydantic 校验失败）
  - `502` 上游依赖失败（跑题通道 gateway 不可达、candidate 引用无效）
  - `503` judge/模型后端不可用（gate 未通过）
  - `401` Host API token 缺失/无效
- **gate（可用性门禁）**：`judge_available()` / `JudgeBackend.available`；`candidate_runner` 的 `available`。gate 失败按上表映射错误码；前端据此降级（如 judgeClient 回退 mock/启发式）。
- **标注**：`[本地]` = 当前实现即落库/本地；`[预留]` = 契约已定、未实现、协作者须遵守字段。

---

## 1. 评测基础设施（judge / craft / chat / arena / likes）

### 1.1 题库与试做题（craft）

| 项 | 内容 |
|---|---|
| 方法/路径 | `GET /api/craft-tasks`（model-service） |
| 鉴权 | 经 Host API 转发（同 `x-clawx-host-session`）；model-service 本机直连 |
| 请求 | 无 |
| 响应 | `Array<{ id: string; jobType: JobType; title: string; prompt: string; targetDims: string[]; checkpoints: string[] }>` |
| 安全 | **不返回 reference_answer / probes**（防刷题，见 `routes/judge.py`） |
| 错误码 | — |
| gate | 无（纯数据） |
| 前端调用方 | 题库镜像 / 面试选题（`src/engine/interview/questionBank.ts` 可同步） |
| 状态 | 本地（已有） |

| 项 | 内容 |
|---|---|
| 方法/路径 | `POST /api/craft-judge`（model-service） |
| 请求 | `{ taskId: string; answer?: string; candidate?: CandidateRef }`（二选一） |
| 响应 | `{ taskId, jobType, dims: Record<string,number>, unscoredDims: string[], checkpoints: [{checkpoint,hit,quote}], paddingDetected, paddingNote, confidence, referenceUsed, ttftMs, latencyMs, backend }` |
| 错误码 | 404 未知题；422 缺 answer/candidate；502 跑题失败；503 judge 不可用 |
| gate | judge 后端可用 |
| 前端调用方 | `judgeClient`（新增 craftJudge 封装）/ 面试 S2 试做环节 |
| 状态 | 本地（已有） |

### 1.2 对话评分（chat）

| 项 | 内容 |
|---|---|
| 方法/路径 | `POST /api/chat-judge`（model-service） |
| 请求 | `{ agentId, agentName?, transcript, usage?, task? }` |
| 响应 | `{ source: 'judge'\|'degraded', radar: RadarScore\|null, verdict?, confidence, evidenceTrace: string[] }`；`source=degraded` 表示启发式降级（confidence 0.35），前端据此决定展示优先级 |
| 错误码 | 422 缺参；503 judge 不可用时**不报错**，返回 degraded |
| gate | judge 可用 → judge；否则 degraded |
| 前端调用方 | `judgeClient.judgeChat`（`src/services/judgeClient.ts`） |
| 状态 | 本地（已有） |

### 1.3 Arena 个性化对决（新增）

| 项 | 内容 |
|---|---|
| 方法/路径 | `POST /api/arena/compare`（model-service；经 Host API 新增转发 `electron/api/routes/arena.ts`） |
| 请求 | `{ requirementText: string; jobType: JobType; candidates: CandidateRef[] }`，`CandidateRef = { agentId, agentName?, channel?: 'text'\|'gateway', answer?, endpoint?, model?, apiKey? }` |
| 响应 | `ArenaMatch(pending)`：`{ matchId, context:'arena', requirementText, taskPrompt, jobType, candidates: [{agentId, agentName, answerText, channel, latencyMs, judgement?, objectiveTotal}], objectiveLeader, userPick:null, status:'pending', eloDelta:{}, createdAt }` |
| 幂等 | 同需求 + 同候选集存在 pending → 返回已有 matchId（200） |
| 错误码 | 422 空需求/缺候选/工种不支持；404 候选通道未知；502 跑题失败；503 judge 不可用 |
| gate | judge 后端可用；candidate 通道可用 |
| 前端调用方 | `judgeClient.arenaCompare`（新增）→ `stores/arenaStore` |
| 状态 | **新增 [本地]**（T02 实现） |

| 项 | 内容 |
|---|---|
| 方法/路径 | `POST /api/arena/user-pick`（model-service；Host API 转发） |
| 请求 | `{ matchId: string; pick: string \| 'draw' \| 'none' }` |
| 响应 | `{ matchId, status:'picked', userPick, winner?: string\|'draw'\|null, eloDelta: Record<string,number>, subjectiveRatings: Record<string,number>, objectiveRatings: Record<string,number> }` |
| 错误码 | 404 未知 match；409 已 pick（幂等拒绝）；422 非法 pick 值 |
| 规则 | `none` 不计 Elo；主观 Elo k=16×userWeight，客观 Elo k=8；initial=1000，clamp[100,3000] |
| gate | 无（纯计算 + 落库） |
| 前端调用方 | `judgeClient.arenaUserPick`（新增） |
| 状态 | **新增 [本地]**（T02 实现） |

### 1.4 小红心点赞（新增）

| 项 | 内容 |
|---|---|
| 方法/路径 | `GET /api/likes/:agentId`（Host API 本地实现 `electron/api/routes/reactions.ts`） |
| 请求 | path 参数 agentId |
| 响应 | `{ agentId, count: number, likedByMe: boolean, users?: string[] /*[预留]*/, updatedAt: string }`；无记录返回 count=0 |
| 错误码 | 400 agentId 空 |
| 状态 | **新增 [本地]**（T05 接入 UI）；`users`/`ownerId` 为**后端聚合预留字段** |

| 项 | 内容 |
|---|---|
| 方法/路径 | `POST /api/likes/:agentId/toggle`（Host API 本地实现） |
| 请求 | 可选 `{ ownerId?: string /*[预留]*/ }` |
| 响应 | 最新 `LikeRecord`（count ±1，likedByMe 翻转） |
| 错误码 | 400 agentId 空 |
| 幂等 | toggle 语义本身幂等（重复调用正常翻转） |
| 前端调用方 | `stores/likesStore`（乐观更新）→ `MarketCandidateCard` 左下角红心 |
| 状态 | **新增 [本地]**；契约预留未来后端聚合（users[] 生效） |

### 1.5 BossFavorite（新增）

| 项 | 内容 |
|---|---|
| 方法/路径 | `GET /api/favorites?jobType=code\|text\|image`（Host API 本地实现） |
| 响应 | `{ jobType, ranking: [{ agentId, agentName?, count, voters: string[] /*[预留]*/ }] }`（按 count 降序） |
| 错误码 | 422 jobType 非法 |
| 前端调用方 | 市场工种赛道「最受 boss 青睐」徽章/排名 |
| 状态 | **新增 [本地]** |

| 项 | 内容 |
|---|---|
| 方法/路径 | `POST /api/favorites/vote`（Host API 本地实现） |
| 请求 | `{ agentId: string; jobType: JobType; stage: 'interview'\|'performance'\|'arena'; sourceId?: string /*interviewId/matchId，幂等键*/; votedBy?: string /*[预留]，本地默认 'default'*/ }` |
| 响应 | `{ agentId, jobType, count, voted: boolean }` |
| 错误码 | 404 未知 agent；409 重复投票（同 agent+stage+sourceId）；422 缺参 |
| 规则 | 一次测评最多投一票（sourceId 幂等键）；可对多个 agent 投票 |
| 前端调用方 | 面试/绩效/Arena 完成页 + 市场页投票入口 |
| 状态 | **新增 [本地]**；`voters`/`votedBy` 为后端聚合预留 |
| 已知限制 | 本地版不校验 agent 存在性（无 agent 注册表，任意 agentId 均 200/409）；404「未知 agent」为后端聚合版语义，协作者对接时若需存在性校验请补充 |

---

## 2. 人才市场（S1）

| 方法/路径 | 说明 | 请求 | 响应 | 错误码 | gate | 前端调用方 | 状态 |
|---|---|---|---|---|---|---|---|
| `GET /api/samples` | 市场样例候选列表（model-service） | — | `Array<CandidateProfile>` | — | 无 | 市场页 mock 数据源 | 本地（已有） |
| `POST /api/upload` | 上传候选媒体（multipart → CandidateProfile） | multipart form | `CandidateProfile` | 422/500 | 无 | 上传流程 | 本地（已有） |
| `POST /api/evaluate` | 深度评估（SSE 事件流：radar_update×6/narration/audio/verdict/done） | `EvaluationRequest` | SSE | 503 judge 不可用 | judge | 评估页 | 本地（已有） |
| `POST /api/evaluate/run` | **Host API 代理** → model-service `/api/evaluate-run`（SSE 流式转发，含收敛事件段） | `JudgeRunInput` | SSE | 503 模型服务不可达 | judge | `judgeClient.evaluate` | 本地（已有） |
| `GET /api/eval/sessions?agentId=` | agent 真实会话列表（Host API 本地） | query | `{success, sessions}` | 400 | 无 | 评估数据 | 本地（已有） |
| `POST /api/eval/collect` | 收集一次运行的 events/transcript/entries | `{agentId?, sessionId?}` | `{success, ...}` | 400/500 | 无 | 评估数据 | 本地（已有） |
| `GET /api/eval/profiles` | 全部评估档案（Host API 本地） | — | `{success, profiles}` | 400 | 无 | `stores/evaluation` | 本地（已有） |
| `PUT /api/eval/profiles` | 覆盖写一份档案 | `EvaluationProfile` | `{success}` | 400 | 无 | `stores/evaluation` | 本地（已有） |
| `GET /api/eval/profiles/:agentId` | 单份档案 | path | `{success, profile}` | 404 | 无 | 详情页 | 本地（已有） |
| `POST /api/eval/runlinks` | 写 runId↔task 关联 | `{runId, taskId, agentId, sessionKey, sessionId}` | `{success, evaluatedAt}` | 400 | 无 | `runLinkStore` | 本地（已有） |
| `GET /api/eval/runlinks/:runId` | 读单条关联 | path | `{success, link}` | 404 | 无 | `runLinkStore` | 本地（已有） |
| `POST /api/evaluate-stage` | 阶段评分卡（S1 初审也用） | `StageScoreRequest` | `StageScore` | 422/503 | 无（启发式可用） | `scoringStore.runStage` / `marketplace.runPrescreen` | 本地（已有） |
| `POST /api/preference` | 偏好信号回灌（Q5） | `PreferenceFeedbackRequest` | `PreferenceProfile` | 422 | 无 | `preferenceStore` | 本地（已有） |

**新增（市场参与面）**：
| 方法/路径 | 说明 | 请求 | 响应 | 错误码 | 状态 |
|---|---|---|---|---|---|
| `GET /api/likes/:agentId` / `POST /api/likes/:agentId/toggle` | 卡片红心（见 1.4） | — | `LikeRecord` | 400 | 新增[本地] |
| `GET /api/favorites?jobType=` / `POST /api/favorites/vote` | 最受青睐（见 1.5） | — | ranking / vote result | 404/409/422 | 新增[本地] |
| `POST /api/arena/compare` / `POST /api/arena/user-pick` | 市场卡「对决」快捷入口（见 1.3） | — | `ArenaMatch` | 404/409/422/502/503 | 新增[本地] |

---

## 3. HR 面试（S2）

| 方法/路径 | 说明 | 请求 | 响应 | 错误码 | gate | 前端调用方 | 状态 |
|---|---|---|---|---|---|---|---|
| `GET /api/craft-tasks` | 题库（不含参考答案） | — | task 列表 | — | 无 | 面试试做选题 | 本地（已有） |
| `POST /api/craft-judge` | 试做题评分（A2/A3） | `{taskId, answer?/candidate?}` | CraftJudgement | 404/422/502/503 | judge | 面试试做环节 | 本地（已有） |
| `POST /api/chat-judge` | 面试对话整段评分 | `{agentId, transcript, ...}` | `{source, radar, ...}` | 422 | judge→degraded | `judgeClient.judgeChat` | 本地（已有） |
| `POST /api/arena/compare` | **用户自定义题**（context='interview'，携带 `interviewId`） | `{requirementText, jobType, candidates, context:'interview', interviewId}` | `ArenaMatch` | 404/422/502/503 | judge+candidate | `stores/interview` + `UserQuestionPanel` | 新增[本地]（T04 接入） |
| `POST /api/arena/user-pick` | 用户自定义题主观选择 | `{matchId, pick}` | pick 结果 + Elo | 404/409/422 | 无 | 同上 | 新增[本地] |

**本地持久化（非 HTTP）**：面试报告存 electron-store `agentcorp.interview`（`src/services/interviewStore.ts`）。新增 `InterviewReport.userQuestionRound?: UserQuestionRound`（仅加法）。

---

## 4. 绩效考核（S3）

| 方法/路径 | 说明 | 请求 | 响应 | 错误码 | gate | 前端调用方 | 状态 |
|---|---|---|---|---|---|---|---|
| `POST /api/evaluate-stage` | 三阶段评分卡（performance 阶段同构） | `StageScoreRequest` | `StageScore` | 422/503 | 无（启发式可用） | `scoringStore.runStage` | 本地（已有） |
| `GET /api/rules` | 读取评分规则 preset | `?presetId=` | `{presetId, rules}` | 404 | 无 | `scoringRulesService` | 本地（已有） |
| `PUT /api/rules` | 覆盖评分规则 | `ScoringRulesLoad` | `{ok}` | 422 | 无 | 同上 | 本地（已有） |
| `GET /api/leaderboard` | 双榜（客观 + 可拖拽主观 + 发散） | `?stage=&jobType=` | `DualLeaderboard` | 422 | 无 | 绩效中心 | 本地（已有） |
| `POST /api/preference` | 拖拽偏好回灌 | `PreferenceFeedbackRequest` | `PreferenceProfile` | 422 | 无 | `preferenceStore` | 本地（已有） |
| `POST /api/convergence/trace` | 收敛轨迹记录 | `{runId, ...}` | `{ok}` | 422 | 无 | `convergenceStore` | 本地（已有） |
| `POST /api/convergence/score` | 收敛评分 | `{runId, ...}` | `ConvergenceScore` | 404/422 | 无 | 同上 | 本地（已有） |
| `GET /api/convergence/anchor` | 读取收敛锚点 | — | anchors | — | 无 | 同上 | 本地（已有） |
| `POST /api/convergence/anchor` | 写收敛锚点 | anchors | `{ok}` | 422 | 无 | 同上 | 本地（已有） |

**新增（S3 参与面）**：BossFavorite 投票入口（`POST /api/favorites/vote`，`stage:'performance'`），见 1.5。

---

## 5. 基础设施

| 方法/路径 | 说明 | 请求 | 响应 | 状态 |
|---|---|---|---|---|
| `GET /health` | model-service 健康检查 | — | `{status:'ok', judgeAvailable, backend}` | 本地（已有） |
| Host API 其他本地路由 | agents/teams/tasks/skills/sessions/approvals/costs/mcp/feishu/usage 等 | — | — | 本地（已有，不在本次契约范围） |

---

## 6. 契约预留清单（未实现但协作者须遵守）

| 字段/端点 | 预留说明 | 当前行为 |
|---|---|---|
| `LikeRecord.users[]` / `ownerId` | 未来后端聚合点赞人集合 | 本地恒空 / 'default' |
| `BossFavoriteVote.voters[]` / `votedBy` | 未来后端多用户聚合 | 本地 'default' |
| `ArenaMatch.eloDelta` 主观/客观双榜 | 已定规则（k=16/8，initial 1000） | T02 实现 |
| `ArenaMatch.context='interview'` | 面试用户题复用 | T04 接入 |
| `/api/likes`、`/api/favorites` 后端聚合版 | 未来 model-service/远端实现，契约字段不变 | Host API 本地实现 |
| `Unknown.severity` | 未来按严重度加权 SC | 已收字段，本期不进权重 |
| `TurnState.unknowns` 增量传输 | 未来可能改增量，当前全量快照 | 每轮全量（首尾比依赖此） |

---

## 6.1 `semantic_contraction` 维度（新增，2026-08-08）

### 新增字段

`TurnState` 新增（旧数据无此字段，缺省空列表）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `unknowns` | `Unknown[]` | 该轮尚未消解的未知项**全量快照**（非增量），默认 `[]` |
| `Unknown.uid` | `string` | 稳定 id，跨轮追踪同一未知项（措辞变化不误判） |
| `Unknown.text` | `string` | 人类可读描述 |
| `Unknown.severity` | `'low'\|'mid'\|'high'` | 预留，本期不进权重，默认 `mid` |

`ConvergenceScore` 新增：

| 字段 | 类型 | 说明 |
|---|---|---|
| `semantic_contraction` | `number` | SC ∈[0,1]，`clamp(1 − \|U_K\|/\|U_0\|, 0, 1)`；**未计算时填 `0.0`** |
| `semantic_scored` | `boolean` | SC 是否真的参与评分 |
| `unknowns_delta` | `number` | `\|U_K\| − \|U_0\|`，**允许负数**，纯诊断不进权重 |

### ⚠️ 消费方硬约束

- **禁止用 `is None` / `?? 0` / `|| 0` 判断 SC 有效性。** 出参恒为 `float`（保
  `toFixed`/`Number` 不崩），「没算」与「一项未知都没消解」**只能**靠
  `semantic_scored` 区分 —— 隐式契约会被某个 `or 0` 吃掉（同 A3 `anchored` 先例）。
- UI 在 `semantic_scored=false` 时显示「—」，不得显示 `0.000`。
- `unknowns_delta > 0` 表示探索中发现新未知，是**真实信号不是错误**，不得
  惩罚为「收敛失败」；SC 侧已 clamp 下界 0 避免负分传导。
- `\|U_0\|==0` 时 SC 判 `None`（出参 `0.0` + `semantic_scored=false`），
  **不给满分** —— 防「不填 unknowns 反拿满分」，同铁律「缺失不得冒充优秀」。

### 权重方案（同族按现存项重新归一化）

| 族 | 项 | 权重 |
|---|---|---|
| 收缩族 | CR | `w1 − 0.25` |
| 收缩族 | SC | `0.25` |
| 对齐族 | 1−R | `w2` |
| 对齐族 | St | `w3` |

任一项不可用时从分母剔除其权重，其余项按剩余权重和归一化。**SC 不可用时
权重回落给同族 CR（得完整 `w1`），与旧公式逐位一致** —— 这是旧 trace 分数
不变的数学保证（实测：锚定+无 unknowns 改前改后同为 `63.4701`）。

### ⚠️ 行为变更公示：未锚定路径改为归一化

**旧行为**：未锚定兜底 `score = 100·w1·CR` 不归一化 → 分数上限被硬压在
`100·w1` = **40 分**。一个 `CR=1.0` 的完美收缩 trace 只因缺人类背书就被判
40 分，无法向用户解释。**那是 bug 而非设计意图。**

**新行为**：归一化后未锚定满分恢复 100（实测同组输入 `24.0` → `60.0`）。

**未锚定 trace 分数会整体上移。聚合端/看板/榜单请勿将此上移误判为回归。**
此变更不影响已锚定 trace（格 2 已逐位对齐）。

---

## 7. 前端调用方索引（新增部分）

| 功能 | 客户端 | Store | 组件 |
|---|---|---|---|
| Arena 对决 | `judgeClient.arenaCompare/arenaUserPick` | `src/stores/arenaStore.ts`（新） | `src/pages/Arena/ArenaPage.tsx`（新）+ `components/arena/*`（新） |
| 面试用户题 | 复用 arena 客户端 | `src/stores/interview.ts`（扩展） | `components/interview/UserQuestionPanel.tsx`（新） |
| 红心 | `reactionStore`（新，electron-store） | `src/stores/likesStore.ts`（新） | `MarketCandidateCard.tsx`（左下角） |
| BossFavorite | `reactionStore`（新） | `stores/marketplace.ts`（扩展） | `components/marketplace/BossFavoriteBadge.tsx`（新） |
