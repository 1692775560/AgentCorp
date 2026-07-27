"""
model-service/app/serve.py
FastAPI 入口（架构 §4.2 / 类图 ServeApp）。

端点：
  GET  /api/samples    → CandidateProfile[]（固定样本清单，含媒体 URL）
  POST /api/evaluate   → SSE 事件流（radar_update/narration/audio/verdict/done）
  POST /api/upload     → multipart → 新 CandidateProfile（P1 上传模式）

设计：前后端彻底解耦，契约见 schemas.py 与前端 src/types/index.ts。
无 NPU 时若 MOCK=true 仍可运行；否则 /api/evaluate 返回 503 明确错误。
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from typing import List

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from .config import settings
from .evaluator import evaluate as run_evaluate
from .evaluator import evaluate_run as run_evaluate_run
from .model_loader import get_model
from .schemas import (
    CandidateProfile,
    EvaluationRequest,
    JudgeRunRequest,
    PersonaText,
    to_event_dict,
)

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


def _load_samples() -> List[CandidateProfile]:
    """读取 samples 目录下各候选的 profile.json。"""
    samples: List[CandidateProfile] = []
    base = settings.samples_dir
    if not os.path.isdir(base):
        logger.warning("样本目录不存在：%s", base)
        return samples
    for name in sorted(os.listdir(base)):
        prof_path = os.path.join(base, name, "profile.json")
        if os.path.isfile(prof_path):
            try:
                with open(prof_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                samples.append(CandidateProfile(**data))
            except Exception as exc:  # noqa: BLE001
                logger.error("读取 %s 失败：%s", prof_path, exc)
    return samples


@app.get("/api/samples")
def get_samples() -> List[CandidateProfile]:
    return _load_samples()


@app.post("/api/evaluate")
async def api_evaluate(req: EvaluationRequest):
    model = get_model()
    if not settings.mock and not model.available:
        raise HTTPException(
            status_code=503,
            detail="模型不可用：无 NPU 或未配置权重。请部署到昇腾环境，或设置 MOCK=true。",
        )

    mode = "mock" if settings.mock else "auto"

    async def event_gen():
        async for ev in run_evaluate(req, mode=mode):
            yield {
                "event": ev["type"],
                "data": json.dumps(to_event_dict(_wrap(ev)), ensure_ascii=False),
            }

    return EventSourceResponse(event_gen())


@app.post("/api/evaluate-run")
async def api_evaluate_run(req: JudgeRunRequest):
    """
    运行期裁判端点（T07）：接收 JudgeRunInput（transcript + usage + task），
    产出与 /api/evaluate 同构的 SSE 事件流（radar_update ×6 + verdict + done）。
    无 NPU / MOCK=true 时走 Mock 派生；模型可用时走真实推理。
    """
    model = get_model()
    if not settings.mock and not model.available:
        raise HTTPException(
            status_code=503,
            detail="模型不可用：无 NPU 或未配置权重。请部署到昇腾环境，或设置 MOCK=true。",
        )

    mode = "mock" if settings.mock else "auto"

    async def event_gen():
        async for ev in run_evaluate_run(req, mode=mode):
            yield {
                "event": ev["type"],
                "data": json.dumps(to_event_dict(_wrap(ev)), ensure_ascii=False),
            }

    return EventSourceResponse(event_gen())


def _wrap(ev: dict):
    """将事件 dict 包装为对应 Pydantic 模型以便序列化（枚举转字符串）。"""
    from . import schemas as S

    mapping = {
        "radar_update": S.RadarUpdateEvent,
        "narration": S.NarrationEvent,
        "audio": S.AudioEvent,
        "verdict": S.VerdictEvent,
        "done": S.DoneEvent,
    }
    cls = mapping.get(ev["type"])
    return cls(**ev) if cls else ev


@app.post("/api/upload")
async def api_upload(
    name: str = Form(...),
    declared_tags: str = Form(""),
    declared_budget: float = Form(200.0),
    persona_text: str = Form(""),
    video: UploadFile = File(None),
    voice: UploadFile = File(None),
    code: UploadFile = File(None),
) -> CandidateProfile:
    """
    P1 上传模式：接收多模态附件，落盘到 upload_dir，返回新 CandidateProfile。
    媒体以服务端 URL 提供（前端据此渲染）。
    """
    os.makedirs(settings.upload_dir, exist_ok=True)
    cid = f"upload-{uuid.uuid4().hex[:8]}"
    cdir = os.path.join(settings.upload_dir, cid)
    os.makedirs(cdir, exist_ok=True)

    def _save(file: UploadFile | None, fname: str) -> str:
        if not file:
            return ""
        path = os.path.join(cdir, fname)
        with open(path, "wb") as f:
            f.write(file.file.read())
        return f"/uploads/{cid}/{fname}"

    video_url = _save(video, "video.mp4")
    voice_url = _save(voice, "voice.wav")
    code_url = _save(code, "code.zip")

    tags = [t.strip() for t in declared_tags.split(",") if t.strip()]
    profile = CandidateProfile(
        id=cid,
        name=name or cid,
        declared_tags=tags,
        declared_budget=declared_budget,
        persona_text=PersonaText(content=persona_text),
        video_demo={"type": "video/mp4", "url": video_url},
        voice_intro={"type": "audio/wav", "url": voice_url},
        artwork=[],
        code_repo={"type": "application/zip", "url": code_url, "lang": "unknown"},
    )
    return profile


@app.get("/health")
def health() -> dict:
    model = get_model()
    return {
        "status": "ok",
        "mock": settings.mock,
        "model_available": model.available,
    }


if __name__ == "__main__":
    uvicorn.run(app, host=settings.host, port=settings.port)
