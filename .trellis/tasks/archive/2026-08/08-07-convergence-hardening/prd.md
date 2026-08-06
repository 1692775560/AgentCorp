# 收敛引擎加固：并发保护 + 合成轨迹诚实标注 + 持久化显式错误

## 背景

代码评审发现 `model-service/app/serve.py` main 分支新加的 Layer3 收敛引擎（T16）存在三个问题：

1. **并发污染**：模块级全局可变 `_TRACE_STORE`（serve.py:80）无任何锁保护。FastAPI sync 端点跑在线程池、SSE 端点协程与线程交错，并发请求下 store 读写与落盘文件写会互相污染（`_persist_convergence` 边迭代 dict 边被别的线程写，且多线程同时 `json.dump` 同一文件会产生截断/交错的坏文件）。
2. **持久化静默失败**：`_persist_convergence`（serve.py:84）失败仅 `logger.warning` 一行，无堆栈、无任何对调用方/前端的信号——落盘丢了没人知道。
3. **合成轨迹冒充实测**：`_build_convergence_trace_from_run`（serve.py:111）用"确定性投影 + 每轮 3 个合成候选"伪造收敛轨迹，通过真实 SSE 事件流（`convergence_update` / `convergence_score`）发给前端，payload 与真实实测轨迹完全同构，前端无法区分真假——演示时有被质疑数据造假的风险。

## Goal

在不破坏既有 SSE 契约（只加字段、不改旧字段语义）的前提下，修复上述三个问题，并为每个修复补充 pytest 用例。

## Requirements

- R1 `_TRACE_STORE` 并发保护：引入 `threading.Lock`，store 全部读写与落盘快照/文件写均在临界区内；在代码注释中写明并发模型（sync 端点走 anyio 线程池、多 worker 进程间不共享内存、落盘为进程内最后写胜出）。
- R2 持久化失败显式化：`_persist_convergence` 失败时 `logger.exception`（带堆栈）并返回 `False`；
  - `/api/convergence/trace`、`/api/convergence/anchor` 响应新增 `persisted: bool` 字段；
  - `/api/evaluate-run` SSE 的 `convergence_score` 事件 payload 新增 `persisted: bool` 字段。
- R3 合成轨迹诚实标注：
  - `/api/evaluate-run` 的 `convergence_update` / `convergence_score` 事件 payload 新增 `"source": "projected"` 与 `"synthetic": true`；
  - serve.py 顶部 docstring 与 `_build_convergence_trace_from_run` docstring 明确说明这是 MVP 确定性投影，非实测数据；
  - 前端低成本识别：`src/types/convergence.ts` 的 `TurnState` / `ConvergenceScore` 增加可选字段，`src/services/judgeClient.ts` 的 `toTurnState` / `toConvergenceScore` 透传（仅加法，缺省 undefined，不影响现有消费方）。
- R4 测试：新增 `model-service/tests/test_convergence_hardening.py`，覆盖：
  - 并发 smoke（多线程并发写 trace，store 与落盘文件均完整）；
  - 持久化失败路径（返回 False、log 带堆栈、响应/事件含 `persisted: false`）；
  - 事件含标注字段（`source == "projected"`、`synthetic is True`）。

## Constraints

- 最小改动，不动无关代码；遵循 serve.py / 前端既有风格（中文注释、snake_case 契约）。
- SSE 事件契约向后兼容：只加字段，不改旧字段语义；前端消费方对未知字段必须安全忽略。
- 不换存储引擎、不引入新依赖；多进程（多 uvicorn worker）一致性不在本期范围，仅以注释说明。
- 不做 git commit / push。

## Acceptance Criteria

- [ ] `_TRACE_STORE` 所有读写均在锁内，`_persist_convergence` 快照+写文件原子（进程内），并发模型有注释。
- [ ] 持久化失败：`logger.exception` 带堆栈；两个 REST 端点响应与 SSE `convergence_score` 事件均携带 `persisted: false`。
- [ ] 合成轨迹事件 payload 含 `source: "projected"` / `synthetic: true`；serve.py docstring 说明 MVP 投影性质；前端类型与解析器透传该标记。
- [ ] 新增 3 个 pytest 用例全绿；`cd model-service && .venv/bin/python -m pytest tests/ -q` 全绿（基线 136 passed, 6 skipped，只允许增加）。
- [ ] 前端 `tsc --noEmit` 不引入新错误。

## Notes

- 多 worker 部署下的跨进程一致性留作后续（需要共享存储或单 worker 约束），本任务只在注释中说明。
