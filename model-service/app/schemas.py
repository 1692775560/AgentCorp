"""
model-service/app/schemas.py
后端 Pydantic 契约（与前端 src/types/index.ts 严格镜像，架构 §4.2 / §8）。

任何一端改动数据结构，必须同步另一端。
"""
from __future__ import annotations

from enum import Enum
from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class RadarDim(str, Enum):
    TASK = "task"
    QUALITY = "quality"
    COMM = "comm"
    CREATIVITY = "creativity"
    RELIABILITY = "reliability"
    COST = "cost"


class Verdict(str, Enum):
    MVP = "MVP"
    OBSERVE = "OBSERVE"
    FIRED = "FIRED"


class Aesthetic(str, Enum):
    MINIMAL = "minimal"
    RICH = "rich"
    NEUTRAL = "neutral"


class RadarScore(BaseModel):
    task: float = 0.0
    quality: float = 0.0
    comm: float = 0.0
    creativity: float = 0.0
    reliability: float = 0.0
    cost: float = 0.0


class WeightVector(BaseModel):
    task: float = 0.2
    quality: float = 0.2
    comm: float = 0.15
    creativity: float = 0.15
    reliability: float = 0.15
    cost: float = 0.15


class UserPreference(BaseModel):
    aesthetic: Aesthetic = Aesthetic.NEUTRAL
    budget_max: float = 200.0
    preferred_stack: List[str] = Field(default_factory=lambda: ["React"])
    weight: WeightVector = Field(default_factory=WeightVector)


class PersonaText(BaseModel):
    type: str = "text/markdown"
    content: str = ""


class MediaRef(BaseModel):
    type: str = ""
    url: str = ""


class CodeRef(BaseModel):
    type: str = "application/zip"
    url: str = ""
    lang: str = ""


class Evaluation(BaseModel):
    radar: RadarScore = Field(default_factory=RadarScore)
    user_fit: float = 0.0
    verdict: Verdict = Verdict.OBSERVE
    evidence_trace: List[str] = Field(default_factory=list)
    confidence: float = 0.0


class CandidateProfile(BaseModel):
    id: str
    name: str = ""
    declared_tags: List[str] = Field(default_factory=list)
    declared_budget: float = 0.0
    persona_text: PersonaText = Field(default_factory=PersonaText)
    video_demo: MediaRef = Field(default_factory=MediaRef)
    voice_intro: MediaRef = Field(default_factory=MediaRef)
    artwork: List[MediaRef] = Field(default_factory=list)
    code_repo: CodeRef = Field(default_factory=CodeRef)
    evaluation: Evaluation = Field(default_factory=Evaluation)


class EvaluationRequest(BaseModel):
    candidate: CandidateProfile
    preference: UserPreference
    options: Optional[dict] = None


# ===================== SSE 事件（五种） =====================
# 运行时每个事件序列化为 dict 后发送：data: <json>\n\n


class RadarUpdateEvent(BaseModel):
    type: Literal["radar_update"] = "radar_update"
    dim: RadarDim
    score: float
    confidence: float
    evidence: str = ""


class NarrationEvent(BaseModel):
    type: Literal["narration"] = "narration"
    delta: str = ""
    is_final: bool = False


class AudioEvent(BaseModel):
    type: Literal["audio"] = "audio"
    chunk: str = ""  # base64：真实为 PCM16/wav 字节；Mock 为 UTF-8 文本
    format: Literal["pcm16", "wav"] = "wav"
    sample_rate: int = 16000


class VerdictEvent(BaseModel):
    type: Literal["verdict"] = "verdict"
    verdict: Verdict
    user_fit: float
    evidence_trace: List[str] = Field(default_factory=list)
    confidence: float = 0.0


class DoneEvent(BaseModel):
    type: Literal["done"] = "done"
    evaluation_id: str = ""


def to_event_dict(event: BaseModel) -> dict:
    """将事件模型转为可 JSON 序列化的 dict（枚举转字符串）"""
    return event.model_dump(mode="json")
