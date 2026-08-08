# A2A P1：委派 trace 采集进评估 — 实施记录

设计依据：`docs/a2a-integration.md` §3.4（trace schema）/ §4 P1（验收标准）。

## 改动文件

| 文件 | 改动 |
|---|---|
| `electron/services/evaluation/a2a-trace.ts` | **新增**。A2aTraceRecord 的 JSONL 读写：`appendA2aTrace`（目录自动创建、追加写、永不抛出返回 boolean）、`readA2aTraces`（坏行跳过、按 sent_at 升序）、`loadA2aTracesForRun`（按 sessionId/agentId 关联，先直读 `<sessionId>.jsonl`， miss 时全目录扫描匹配 root_session_id / task_id / session_key / delegator / delegatee）、`deriveRootSessionId` / `delegatorFromSessionKey`（sessionKey 解析）。落盘 `~/.openclaw/a2a-traces/<rootSessionId>.jsonl`。 |
| `src/types/evaluation.ts` | 仅加法：`A2aTraceKind` / `A2aTraceState` / `A2aTraceRecord`（§3.4 schema + 三个仅加法扩展字段 `session_key` / `root_session_id` / `trigger`）。 |
| `electron/services/session-runtime-manager.ts` | spawn/steer/kill 埋点：新增私有 `writeA2aTrace()`（全 try/catch，失败吞掉），分别在 chat.send 成功后（spawn、steer）与 chat.abort 成功后（kill）各写一条。round 由同 task_id 既有 trace 数 +1 推导；steer 的 `rework_of` 指向同 task_id 上一条 message 的 trace_id；kill 记 `state=canceled`、`completed_at=now`。委派主流程行为零变化。 |
| `electron/services/evaluation/eval-data.ts` | `collectRunData` 增加第三数据源：有 trace 时 `events` 由 `telemetryFromA2aTraces` 客观计算（rework=rework_of≠null 数、escalations=input-required 数、human_interventions=steer 数、latency_ms=trace 首末时间差、first_try 派生）；无 trace 时既有兜底逐字不变。`RunData` 仅加法 `traces` 字段。 |
| `src/services/evaluationData.ts` | 渲染层 `RunData` 仅加法 `traces` 并透传（`/api/eval/collect` 经 `...data` 自动带出）。 |
| `tests/unit/a2a-trace.test.ts` | **新增** 9 条：schema 读写/派生函数/写失败容错、spawn+steer+kill 埋点链、trace 写失败不影响委派、collectRunData 消费后 rework=1/latency=65000/escalations=1、无 trace 兜底不变、按 delegatee 关联。fs 用 `vi.hoisted` 进程级临时目录隔离。 |
| `.trellis/tasks/08-09-a2a-p1-trace/prd.md` | 补写为正式 PRD。 |

## trace schema 最终字段

§3.4 全部字段（trace_id / task_id / parent_task_id / delegator / delegatee / round / kind / state / rework_of / channel / sent_at / completed_at / summary）+ 仅加法扩展 `session_key`、`root_session_id`（落盘文件名与评估关联键）、`trigger`（spawn/steer/kill，区分人工 steer 计入 human_interventions）。

## 与设计文档的出入

1. **schema 加三个扩展字段**（见上）：设计 §3.4 未定义关联键，但 P1 要求"按 sessionId/agentId 关联"，纯 A2A 字段无法从 collectRunData 的 (agentId, sessionId) 反查到 trace 文件，故补 `root_session_id`/`session_key`；`trigger` 用于区分人工 steer（本代码库中 `SessionRuntimeManager.steer` 仅由 Host API 人工触发）。
2. **latency_ms 口径**：设计写「终态 completed_at − 首条 submitted sent_at」，但 P1 内部埋点 completed_at 大多为 null（只有 kill 写），按任务要求采用「trace 首末时间差」（sent_at/completed_at 的最小→最大），trace 算不出时回退既有 usage 估算。
3. **comm 维 evidence 引用 trace_id**：P1 只把 `traces` 送到渲染层 RunData（仅加法、后端 pydantic 忽略未知字段的先例），judge prompt 的证据段拼接属 P4（model-service 侧），未在本任务做。

## 验证

- `corepack pnpm vitest run tests/unit/a2a-trace.test.ts`：9/9 通过。
- `corepack pnpm typecheck`：通过（tsc 双 config 均无输出）。
- `corepack pnpm lint:check`：0 error（76 warning 均为存量，新增文件 0 warning）。
- `corepack pnpm test`：366/366 通过（基线 357 + 新增 9）。

## 遗留

- judge prompt 消费 trace 证据段（P4，`model-service/app/prompt_templates.py` + `schemas.py` 加 `a2a_trace`）。
- `loadA2aTracesForRun` 的 agentId 兜底匹配会捞到该 agent 全部历史 trace（与既有 usage 按 agentId 兜底同源语义）；真 A2A wire（P2/P3）接入后应以 task_id 为主键收敛。
- KPI 聚合（rework_rate/escalation_rate/autonomy_rate）随真实 TelemetryEvent 自动受益，无需改动。
