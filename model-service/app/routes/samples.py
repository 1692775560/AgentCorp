"""样本集端点：GET /api/samples（纯搬运自原 serve.py）。"""
from __future__ import annotations

import json
import logging
import os
from typing import List

from fastapi import APIRouter

from ..config import settings
from ..schemas import CandidateProfile

logger = logging.getLogger("serve")

router = APIRouter()


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


@router.get("/api/samples")
def get_samples() -> List[CandidateProfile]:
    return _load_samples()
