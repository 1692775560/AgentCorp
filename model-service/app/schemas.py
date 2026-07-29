"""
model-service/app/schemas.py
后端 Pydantic 契约（与前端 src/types/index.ts 严格镜像，架构 §4.2 / §8）。

任何一端改动数据结构，必须同步另一端。
"""
from __future__ import annotations

from enum import Enum
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, ConfigDict, AliasGenerator
from pydantic.alias_generators import to_camel


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


# ===================== 运行期裁判请求（/api/evaluate-run） =====================
class JudgeTask(BaseModel):
    """评估关联的任务（轻量结构，对齐前端 JudgeRunInput.task）"""
    title: str = ""
    description: str = ""
    weight: float = 1.0


class JudgeRunRequest(BaseModel):
    """
    运行期裁判请求（评估设计 §1.3 / T07）。
    由前端 judgeClient 经 Host API 代理 POST 至模型服务。
    携带真实 transcript + usage（TokenUsageHistoryEntry[]）+ task，
    后端据此产出与 /api/evaluate 同构的 SSE 事件流
    （radar_update ×6 + verdict + done）。

    契约兼容：前端经 Host API 代理发送的 JSON 为 camelCase（agentId /
    agentName），而后端旧有测试与内部调用使用 snake_case（agent_id /
    agent_name）。此处通过 pydantic 的 AliasGenerator + populate_by_name 同时
    接受两种写法，避免前端真实请求缺少 agent_id 触发 422 而静默回退 mock。
    """
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    agent_id: str
    agent_name: str = ""
    persona: Optional[str] = None
    task: JudgeTask = Field(default_factory=JudgeTask)
    transcript: str = ""
    usage: List[dict] = Field(default_factory=list)
    preference: Optional[dict] = None
    # Layer3 收敛扩展（T16，可选）：命中则 /api/evaluate-run 记录收敛轨迹
    # 并发 convergence_update / convergence_score SSE 事件（不破坏既有字段）。
    convergence: Optional[dict] = None


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
