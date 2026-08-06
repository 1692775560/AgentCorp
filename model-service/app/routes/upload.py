"""上传端点：POST /api/upload（纯搬运自原 serve.py）。"""
from __future__ import annotations

import logging
import os
import uuid

from fastapi import APIRouter, File, Form, UploadFile

from ..config import settings
from ..schemas import CandidateProfile, PersonaText

logger = logging.getLogger("serve")

router = APIRouter()


@router.post("/api/upload")
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
