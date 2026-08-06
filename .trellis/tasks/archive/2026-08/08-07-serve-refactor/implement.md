# implement.md — serve.py 路由拆分模块化

## 结果

`model-service/app/serve.py`（634 行 → 约 70 行）拆为装配层 + `app/routes/` 包，纯搬运、零行为变更。

## 拆分清单

| 文件 | 内容 |
| --- | --- |
| `app/routes/__init__.py` | 包说明 |
| `app/routes/_common.py` | `datetime_now_iso`（convergence 与 leaderboard 共用，逐字搬运） |
| `app/routes/samples.py` | `GET /api/samples` + `_load_samples` |
| `app/routes/evaluate.py` | `POST /api/evaluate`、`POST /api/evaluate-run`（SSE：convergence_update → task_run（内嵌 Task-Set 调度）→ 主裁判流 → convergence_score）、`_wrap` |
| `app/routes/upload.py` | `POST /api/upload` |
| `app/routes/convergence.py` | `_ENGINE` / `_TRACE_STORE` / `_TRACE_LOCK` / `_CONV_STORE_PATH` / `_persist_convergence` / `ConvergenceScoreRequest` / `_build_convergence_trace_from_run` + `/api/convergence/{trace,score,anchor}` 4 端点 |
| `app/routes/leaderboard.py` | `POST /api/evaluate-stage`、`GET/PUT /api/rules`、`GET /api/leaderboard`、`POST /api/preference` + `_STAGE_STORE` / `_RULES_OVERRIDES` / `_mock_leaderboard_entries`（批次2 共享状态内聚） |
| `app/routes/health.py` | `GET /health` |
| `app/serve.py` | 仅装配：logging、FastAPI、CORS、`/uploads` 挂载（保留 import 时 makedirs 副作用）、include_router ×6、`__main__` |

依赖方向：`evaluate → convergence`、`convergence/leaderboard → _common`、`serve → routes/*`，无循环 import。所有 routes 模块 logger 沿用 `logging.getLogger("serve")`。

## 与 PRD 建议的偏差

- 无独立 `tasks.py`：Task-Set 调度不是独立路由，内嵌在 `/api/evaluate-run` 的 SSE 流中，随 evaluate 域（已在 PRD 中说明）。
- `rules`/`preference` 未单建模块：与 evaluate-stage/leaderboard 共享进程内状态且同属批次2，合入 `leaderboard.py`。

## 测试改动（唯一一处）

`tests/test_convergence_hardening.py`：monkeypatch/直调目标由 `app.serve` 内部状态改为 `app.routes.convergence`（`conv._CONV_STORE_PATH` / `conv._TRACE_LOCK` / `conv._TRACE_STORE` / `conv._persist_convergence` / `conv.api_convergence_trace`）。断言与用例语义未动；`serve.app` 仍用于 TestClient。

## 验证

- 路由表前后 diff：`app.routes` 的 method+path 清单逐条一致（注意 FastAPI 0.141 的 `include_router` 是惰性 `_IncludedRouter`，需遍历 `original_router.routes` 枚举）；`/uploads` 挂载保留。
- `cd model-service && .venv/bin/python -m pytest tests/ -q`：**140 passed, 6 skipped**（与基线完全一致），含 4 个收敛加固用例（并发锁、落盘失败显式化、projected/synthetic 标注）。

## 遗留

- 未做 git commit（按要求）。
