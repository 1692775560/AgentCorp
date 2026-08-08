# A2A P1：委派 trace 采集进评估（rework/escalation 客观化）

上游设计：`docs/a2a-integration.md` §3.4（trace schema）与 §4 P1（验收标准）。

## Goal

把 leader→worker 委派过程（`SessionRuntimeManager` 的 spawn/steer/kill）按统一 A2A 语义 schema 落盘为 trace，并让 `collectRunData` 消费 trace 产出**真实**的 `rework` / `escalations` / `latency_ms`，替代当前硬编码 0 的假数据（`eval-data.ts:259-272`），为六维评估的 comm/reliability 维提供客观证据链。

## Requirements

- 新增 `electron/services/evaluation/a2a-trace.ts`：A2aTraceRecord schema + JSONL 追加落盘（`~/.openclaw/a2a-traces/`，目录自动创建），读写全容错——trace 失败绝不影响委派主流程。
- `SessionRuntimeManager.spawn / steer / kill` 埋点写 trace：delegator / delegatee / round / rework_of / state / 耗时，埋点全 try/catch，委派主流程行为零变化。
- `collectRunData` 增加第三数据源：按 sessionId/agentId 关联 trace 记录；有 trace 时 `rework`（steer 次数）、`escalations`、`latency_ms`（trace 首末时间差）由 trace 客观计算；无 trace 时保持现有兜底行为逐字节不变（向后兼容）。
- 类型仅加法：`A2aTraceRecord` 加入 `src/types/evaluation.ts`；`RunData`（主进程 + 渲染层客户端）仅加法携带 trace，供 judge 证据引用 trace_id。
- 单测 `tests/unit/a2a-trace.test.ts`：schema 读写、埋点→trace、collectRunData 消费后 rework≥1 / latency>0、无 trace 兜底不变；文件系统 mock 到临时目录。
- 门禁：`corepack pnpm typecheck` / `corepack pnpm lint:check`（0 error）/ `corepack pnpm test`（基线 357 全绿 + 新增）。

## Acceptance Criteria

- [ ] 完成一次 leader→worker 委派（含一次 steer 返工）后，`POST /api/eval/collect` 返回的 events 中 `rework ≥ 1`、`latency_ms > 0`（单测模拟验证）。
- [ ] trace 文件为 JSONL，每行一条符合 §3.4 schema 的记录，落盘目录自动创建。
- [ ] trace 读写任一步失败（目录不可写、JSON 损坏行等）不抛出、不影响 spawn/steer/kill/collectRunData 主流程。
- [ ] 无 trace 时 `collectRunData` 输出与改造前完全一致（既有 collectors.test.ts 断言不删改仍通过）。
- [ ] typecheck / lint 0 error / vitest 全绿。

## Notes

- 最小侵入；不改 OpenClaw gateway、不动 `chat.send` 委派链路、不动 `TelemetryEvent` 既有字段语义。
- judge prompt 消费 trace 证据段属 P4（`model-service` 侧），P1 只保证 trace 数据可达渲染层（仅加法字段，后端 pydantic 忽略未知字段）。
- 真 A2A wire（Adapter / AgentCard / endpoint）属 P2/P3，本任务不做。
