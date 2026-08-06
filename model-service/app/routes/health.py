"""健康检查端点：GET /health（纯搬运自原 serve.py）。"""
from __future__ import annotations

import logging

from fastapi import APIRouter

from ..config import settings
from ..model_loader import get_model

logger = logging.getLogger("serve")

router = APIRouter()


@router.get("/health")
def health() -> dict:
    model = get_model()
    return {
        "status": "ok",
        "mock": settings.mock,
        "model_available": model.available,
    }
