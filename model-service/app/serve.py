"""
model-service/app/serve.py
FastAPI 入口——仅应用装配。

路由按域拆分在 app/routes/ 包（APIRouter，纯搬运，行为不变）：
  samples.py      GET  /api/samples
  evaluate.py     POST /api/evaluate、POST /api/evaluate-run（SSE 事件流，
                        含收敛事件段与内嵌 Task-Set 调度）
  upload.py       POST /api/upload（multipart → CandidateProfile）
  convergence.py  /api/convergence/{trace,score,anchor} + 引擎进程内状态
                  （_TRACE_STORE / _TRACE_LOCK / _persist_convergence）
  leaderboard.py  POST /api/evaluate-stage、GET/PUT /api/rules、
                  GET /api/leaderboard、POST /api/preference
  health.py       GET  /health

设计：前后端彻底解耦，契约见 schemas.py 与前端 src/types/index.ts。
无 NPU 时若 MOCK=true 仍可运行；否则 /api/evaluate 返回 503 明确错误。
"""
from __future__ import annotations

import logging
import os

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import settings
from .routes import arena, convergence, evaluate, health, judge, leaderboard, samples, upload

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("serve")

app = FastAPI(title="AgentCorp MiniCPM-o Evaluator", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# /api/upload 落盘目录同时以 /uploads 静态挂载（前端据返回 URL 渲染媒体）
os.makedirs(settings.upload_dir, exist_ok=True)
app.mount(
    "/uploads",
    StaticFiles(directory=settings.upload_dir),
    name="uploads",
)

app.include_router(samples.router)
app.include_router(evaluate.router)
app.include_router(upload.router)
app.include_router(convergence.router)
app.include_router(leaderboard.router)
app.include_router(judge.router)
app.include_router(health.router)
app.include_router(arena.router)


if __name__ == "__main__":
    uvicorn.run(app, host=settings.host, port=settings.port)
