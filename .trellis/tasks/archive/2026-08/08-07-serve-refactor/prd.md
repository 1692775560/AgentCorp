# model-service 结构重构：serve.py 路由拆分模块化

## Goal

`model-service/app/serve.py`（约 634 行）当前承载全部 13 个业务端点 + 收敛引擎进程内状态 + 持久化逻辑 + 应用装配。将其按路由域拆分为 `app/routes/` 包，`serve.py` 只保留应用装配（创建 app、CORS、`/uploads` 静态挂载、include_router、`__main__` 入口）。

**铁律：纯搬运，不改任何行为。** 路由路径、HTTP 方法、SSE 事件序列与 payload 字段（含 `source`/`synthetic`/`persisted` 诚实标注）、状态码、`_TRACE_LOCK` 锁保护范围、日志 logger 名称（`"serve"`）全部原样保留。不做任何"顺手优化"。

## 现状路由表（重构前快照，重构后必须逐条一致）

- `GET /api/samples`
- `POST /api/evaluate`（SSE）
- `POST /api/evaluate-run`（SSE：convergence_update ×N → task_run? → radar_update… → convergence_score?）
- `POST /api/upload`
- `POST /api/evaluate-stage`（SSE：stage_score → done）
- `GET /api/rules` / `PUT /api/rules`
- `GET /api/leaderboard`
- `POST /api/preference`
- `POST /api/convergence/trace`、`POST /api/convergence/score`
- `GET /api/convergence/anchor`、`POST /api/convergence/anchor`
- `GET /health`

## Requirements

### 模块划分（`app/routes/` 包，各域一个 `APIRouter`）

以实际路由归属与共享状态内聚性分组（与最初建议略有调整：不存在独立的 Task-Set 路由——任务集调度内嵌在 `/api/evaluate-run` 的 SSE 流中，随 evaluate 域走；批次2 的 evaluate-stage/rules/leaderboard/preference 共享 `_STAGE_STORE`/`_RULES_OVERRIDES` 进程内状态，合入一个模块）：

| 模块 | 路由 | 随模块搬迁的状态/辅助 |
| --- | --- | --- |
| `routes/samples.py` | `GET /api/samples` | `_load_samples` |
| `routes/evaluate.py` | `POST /api/evaluate`、`POST /api/evaluate-run` | `_wrap`；event_gen 内的收敛事件段与 Task-Set 调度段原样保留 |
| `routes/upload.py` | `POST /api/upload` | — |
| `routes/convergence.py` | `/api/convergence/trace|score|anchor`（4 个） | `_ENGINE`、`_TRACE_STORE`、`_TRACE_LOCK`、`_CONV_STORE_PATH`、`_persist_convergence`、`ConvergenceScoreRequest`、`_build_convergence_trace_from_run` |
| `routes/leaderboard.py` | `POST /api/evaluate-stage`、`GET/PUT /api/rules`、`GET /api/leaderboard`、`POST /api/preference` | `_STAGE_STORE`、`_RULES_OVERRIDES`、`_mock_leaderboard_entries` |
| `routes/health.py` | `GET /health` | — |
| `routes/_common.py` | — | `datetime_now_iso`（convergence 与 leaderboard 共用，逐字搬运） |

依赖方向：`evaluate.py` → `convergence.py`（轨迹构建/写 store/落盘）；`convergence.py`、`leaderboard.py` → `_common.py`；`serve.py` → 全部 routes。无循环 import。

### serve.py（装配层）

只保留：模块 docstring、`logging.basicConfig` + `logger`、`FastAPI(...)`、CORS middleware、`os.makedirs(settings.upload_dir)` + `/uploads` StaticFiles 挂载（**必须保持在 import 时执行**，test_http.py 等依赖该副作用）、`include_router` × 6、`uvicorn.run` 入口。

### 日志与可观测性

各 routes 模块继续使用 `logging.getLogger("serve")`，保证日志记录名不变（`test_convergence_hardening.py` 的 caplog 断言依赖 `r.name == "serve"`）。

### 测试适配（唯一允许的测试改动）

`tests/test_convergence_hardening.py` 直接 patch/调用 serve 模块内部状态（`_CONV_STORE_PATH`、`_TRACE_LOCK`、`_TRACE_STORE`、`_persist_convergence`、`api_convergence_trace`）。状态搬到 `app/routes/convergence.py` 后，monkeypatch 必须指向新模块才生效（patch serve 上的 re-export 名字不会影响函数读取的模块全局）。因此将该测试的引用改为 `app.routes.convergence`，**断言逻辑与用例语义一律不变**。其余测试仅经 `app.serve.app` 走 HTTP，无需改动。

## Acceptance Criteria

- [ ] `app/routes/` 包按上表建成，`serve.py` 仅剩装配（约 60 行内）。
- [ ] `cd model-service && .venv/bin/python -m pytest tests/ -q` 结果 = 基线 `140 passed, 6 skipped`。
- [ ] 重构前后路由表（`app.routes` 的 method+path 清单）逐条 diff 一致（含 `/uploads` 挂载）。
- [ ] 收敛 SSE 事件的 `source="projected"` / `synthetic=true` / `persisted` 标注与锁保护代码逐字保留（pytest 中对应 4 个 hardening 用例通过）。
- [ ] 除 `test_convergence_hardening.py` 的引用指向调整外，无其他测试改动；无任何行为变更。

## Notes

- 基线：重构前 `140 passed, 6 skipped`（已实测）；路由表快照存于 `/tmp/routes_before.txt`。
- 不 git commit / push；archive 脚本自身的 auto-commit 属工具内建行为。
