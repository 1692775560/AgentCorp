# implement.md — 08-07-convergence-hardening

## 改动清单

### 后端 model-service/app/serve.py

1. **并发保护（问题 1）**
   - 新增 `import threading`（serve.py:19）。
   - `_TRACE_LOCK = threading.Lock()`（serve.py:88），并在 serve.py:91-100 用注释写明并发模型：sync 端点跑 anyio 线程池、SSE 协程也会写 store → 所有 `_TRACE_STORE` 读写持锁；多 uvicorn worker 是多进程、内存不共享、落盘最后写胜出（跨进程一致性不在 MVP 范围）。
   - 持锁点：`_persist_convergence` 全程（快照迭代 + 文件写原子，serve.py:110-116）、`/api/evaluate-run` event_gen 写 store（serve.py:278）、`/api/convergence/trace`（serve.py:587）、`/api/convergence/score` 读 store（serve.py:598）。

2. **持久化失败显式化（问题 2）**
   - `_persist_convergence` 返回 `bool`；失败改 `logger.warning` 为 `logger.exception`（带堆栈，serve.py:119），不再静默。
   - `/api/convergence/trace` 响应新增 `persisted` 字段（serve.py:590）；`/api/convergence/anchor` 响应新增 `persisted` 字段（serve.py:620）；`/api/evaluate-run` 的 `convergence_score` 事件 payload 新增 `persisted`（serve.py:318/323）。

3. **合成轨迹诚实标注（问题 3）**
   - serve.py 顶部 docstring（serve.py:13-17）与 `_build_convergence_trace_from_run` docstring（serve.py:144-146）明确说明这是 MVP 确定性投影、非实测。
   - `convergence_update` 事件 payload 新增 `"source": "projected"` / `"synthetic": true`（serve.py:285-286）；`convergence_score` 同样标注（serve.py:321-322）。仅加字段，旧字段语义不变，向后兼容。

### 前端（低成本识别标记）

- `src/types/convergence.ts`：`TurnState` 新增可选 `source?: 'projected' | 'measured'`、`synthetic?: boolean`；`ConvergenceScore` 新增可选 `source` / `synthetic` / `persisted`。
- `src/services/judgeClient.ts`：`toTurnState` / `toConvergenceScore` 透传这三个字段（旧后端无此字段 → undefined，向后兼容）。

### 测试 model-service/tests/test_convergence_hardening.py（新增，4 用例）

- `test_trace_store_concurrent_writes_smoke`：16 线程并发记录轨迹，断言无异常、store 16 条、落盘 JSON 可完整解析且含全部 16 条。
- `test_persist_failure_returns_false_and_logs_stack`：落盘路径父目录不存在 → 返回 False、caplog 有 ERROR 且带 `exc_info`、REST 响应 `persisted: false`。
- `test_evaluate_run_persist_failure_marked_in_sse`：SSE `convergence_score` 事件携带 `persisted: false`。
- `test_evaluate_run_events_labeled_projected`：所有 `convergence_update` / `convergence_score` 事件含 `source=="projected"`、`synthetic is True`，且旧字段（turn/candidates/convergence_score）仍在。

## 为什么这样改

- 锁粒度取"整个 persist 持锁"而非"锁内快照、锁外写文件"：多线程同时 `json.dump` 同一文件会交错/截断，文件写必须在临界区内；临界区仅 dict 操作 + 小文件写，对事件循环阻塞可忽略。
- 标注放在事件 payload 而非改 `TurnState`/`ConvergenceScore` Pydantic 模型：投影是 serve 层 `/api/evaluate-run` 侧信道的性质，scoring 层模型本身可同时承载真实轨迹（`/api/convergence/trace` 写入的），不应把 synthetic 烙进数据模型。
- 失败信号走"返回值 + 各出口显式字段"而非抛异常：保持 SSE 流不中断（既有兜底语义），同时让前端/调用方能显式感知。

## 验证

- `cd model-service && .venv/bin/python -m pytest tests/ -q` → **140 passed, 6 skipped**（基线 136 passed, 6 skipped + 新增 4）。
- 前端 `pnpm run typecheck`（tsc --noEmit × 2）→ 通过，无错误。
- `pnpm exec vitest run tests/unit/judgeClient.test.ts` → 5 passed。

## 遗留问题

- 多 uvicorn worker（多进程）下 `_TRACE_STORE` 不共享、落盘文件最后写胜出——已在 serve.py:91-100 注释说明，跨进程一致性需共享存储或单 worker 部署约束，留待后续。
- 前端 UI（ConvergenceTrajectoryWidget / convergenceStore）目前未消费 `source`/`synthetic`/`persisted` 标记做展示（如"投影演示数据"徽标）；类型与解析已透传，展示层接入是低成本的后续项。
- 未做 git commit / push（按任务约束）。
