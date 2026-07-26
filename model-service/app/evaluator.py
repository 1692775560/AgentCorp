"""
model-service/app/evaluator.py
跨模态评估 pipeline（架构 §1.3 / 类图 Evaluator）。

pipeline：load_media → build_prompt → infer → parse → compute_fit → stream

设计要点：
- compute_user_fit 与前端 src/utils/radar.ts 严格一致（同一公式镜像）。
- MOCK_FIXTURES 与前端 src/mock/samples.ts 同源（同一批候选 id）。
- 无 NPU 时走 Mock 事件流，保证服务可运行、可测试（tests/test_evaluate.py）。
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
from typing import AsyncGenerator, Dict, List, Optional

from .config import settings
from .model_loader import get_model
from .prompt_templates import build_evaluation_messages
from .schemas import (
    Aesthetic,
    CandidateProfile,
    EvaluationRequest,
    RadarScore,
    RadarDim,
    UserPreference,
    Verdict,
)
from .tts import tts_bridge

logger = logging.getLogger("evaluator")

RADAR_DIMS: List[str] = [
    "task",
    "quality",
    "comm",
    "creativity",
    "reliability",
    "cost",
]


# ======================================================================
# 1) 用户契合度计算（与前端 src/utils/radar.ts 严格一致）
# ======================================================================
def compute_user_fit(
    radar: RadarScore,
    preference: UserPreference,
    declared_budget: float,
    declared_tags: List[str],
    inferred_aesthetic: Optional[str] = None,
) -> tuple[float, List[str]]:
    """
    user_fit = Σ(radar[dim]/5 × weight[dim]) × 100%
    叠加：预算硬约束（超预算则 cost 权重清零）、
         审美硬约束（不符 -8% / 相符 +2%）、技术栈加分（命中 ×1.5%，上限 6%）。
    结果裁剪至 [0,100]。
    """
    weight = dict(preference.weight.model_dump())
    evidence: List[str] = []

    # 预算硬约束
    if declared_budget > preference.budget_max:
        weight["cost"] = 0.0
        evidence.append(
            f"声明预算 {declared_budget} 超过上限 {preference.budget_max}，"
            f"性价比维度权重清零"
        )

    # 加权基础分
    weighted = 0.0
    for dim in RADAR_DIMS:
        weighted += (getattr(radar, dim) / 5.0) * weight[dim]
    # PRD §7.3 / 架构 §4.3：Σ weight = 1，user_fit = Σ(radar/5 × weight) × 100%。
    # 不做归一化：超预算清零 cost 权重后总分自然 < 100（预算硬约束真正生效）。
    fit = weighted * 100.0

    # 审美硬约束/减分
    if preference.aesthetic.value != "neutral" and inferred_aesthetic:
        if inferred_aesthetic != preference.aesthetic.value:
            fit -= 8.0
            evidence.append("审美取向与偏好不符，扣 8%")
        else:
            fit += 2.0
            evidence.append("审美取向契合，加 2%")

    # 技术栈加分
    overlap = [t for t in declared_tags if t in preference.preferred_stack]
    if overlap:
        bonus = min(len(overlap) * 1.5, 6.0)
        fit += bonus
        evidence.append(
            f"技术栈命中 {len(overlap)} 项（{','.join(overlap)}），加 {bonus}%"
        )

    fit = max(0.0, min(100.0, round(fit * 10) / 10))
    return fit, evidence


# ======================================================================
# 2) 结构化输出解析（缓解 R4 漂移，架构 D7）
# ======================================================================
def parse_output(raw: str) -> Dict:
    """
    从模型自由文本中抽取 JSON（容忍 ```json 代码块包裹与前后多余文本）。
    返回含 radar/verdict/confidence/evidence_trace/narration/audio_script 的 dict。
    """
    text = raw.strip()
    # 优先提取 ```json ... ``` 代码块
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if m:
        text = m.group(1)
    else:
        # 退路：截取首个 { 到末个 }
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            text = text[start : end + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"无法解析模型输出为 JSON：{exc}") from exc

    # 规整 radar
    radar_raw = data.get("radar", {})
    radar = RadarScore(
        task=float(radar_raw.get("task", 0.0)),
        quality=float(radar_raw.get("quality", 0.0)),
        comm=float(radar_raw.get("comm", 0.0)),
        creativity=float(radar_raw.get("creativity", 0.0)),
        reliability=float(radar_raw.get("reliability", 0.0)),
        cost=float(radar_raw.get("cost", 0.0)),
    )
    verdict = Verdict(data.get("verdict", "OBSERVE"))
    confidence = float(data.get("confidence", 0.0))
    evidence = list(data.get("evidence_trace", []))
    narration = str(data.get("narration", ""))
    audio_script = str(data.get("audio_script", narration))
    return {
        "radar": radar,
        "verdict": verdict,
        "confidence": confidence,
        "evidence_trace": evidence,
        "narration": narration,
        "audio_script": audio_script,
    }


# ======================================================================
# 3) Mock fixture（与前端 src/mock/samples.ts 同源）
# ======================================================================
MOCK_FIXTURES: Dict[str, Dict] = {
    "candidate-01": {
        "radar": RadarScore(
            task=4.5, quality=5.0, comm=4.5, creativity=4.0, reliability=4.5, cost=4.0
        ),
        "verdict": Verdict.MVP,
        "confidence": 0.92,
        "inferred_aesthetic": "minimal",
        "narration": (
            "琳达的短视频 demo 完整演示了组件库搭建过程，与代码库内容一致。"
            "产出质量极高，设计稿专业且极简。语音自述逻辑清晰，沟通力强。"
            "创意上做了差异化定位，但仍有提升空间。综合来看是本月最值得签约的候选。"
        ),
        "audio_script": (
            "你好，我是 MiniCPM-o 全模态 HR 总监。下面为你讲解琳达的评估结果。"
            "琳达的短视频、代码与作品图高度一致，产出质量达到满分水准，审美也是你偏好的极简风。"
            "沟通和创意都很出色，预算也在你的上限之内。综合判定：本月 MVP。"
        ),
        "evidence_trace": [
            "视频 demo 展示的组件与 code_repo 中代码一致（claim=demo）",
            "作品图 design-tokens 体现极简审美，与偏好 aesthetic=minimal 契合",
            "语音自述结构清晰，信息密度高（表达沟通 4.5）",
            "预算 180 ≤ 200，性价比维度未触发硬约束",
        ],
    },
    "candidate-02": {
        "radar": RadarScore(
            task=4.0, quality=3.5, comm=3.0, creativity=2.5, reliability=4.5, cost=3.5
        ),
        "verdict": Verdict.OBSERVE,
        "confidence": 0.85,
        "inferred_aesthetic": "neutral",
        "narration": (
            "老张的 Python 后端代码稳定、可运行，可靠性强。但表达沟通偏薄弱，"
            "创意差异化不足，整体偏保守。预算 220 略微超出上限，性价比维度被约束。"
            "建议进入观察期，针对性培训沟通与创意。"
        ),
        "audio_script": (
            "接下来是老张的评估。他的后端代码很稳，可靠性突出，但表达与创意较弱，"
            "预算也略微超了一点。整体可用但非首选，判定为待观察，建议进入培训期。"
        ),
        "evidence_trace": [
            "code_repo 单元测试通过，逻辑稳定（可靠性 4.5）",
            "语音自述信息密度低，缺乏结构化（表达沟通 3.0）",
            "预算 220 > 200，性价比维度权重清零",
            "作品无明显差异化卖点（创意 2.5）",
        ],
    },
    "candidate-03": {
        "radar": RadarScore(
            task=3.0, quality=2.5, comm=2.5, creativity=3.5, reliability=1.5, cost=1.0
        ),
        "verdict": Verdict.FIRED,
        "confidence": 0.78,
        "inferred_aesthetic": "rich",
        "narration": (
            "阿强声明的预算高达 300，严重超支，性价比极低。视频中宣称的高并发能力"
            "在代码库里找不到对应实现，存在注水风险。可靠性差，沟通也一般。"
            "综合判定：You are fired。"
        ),
        "audio_script": (
            "最后是阿强。他的预算高达 300，远超上限，性价比几乎为零。更关键的是，"
            "视频里吹的高并发，在代码里根本找不到对应实现，存在明显注水。"
            "可靠性也很差。综合判定：You are fired。"
        ),
        "evidence_trace": [
            "声明预算 300 >> 200，性价比维度权重清零（cost=1.0）",
            "视频 claim 高并发，但 code_repo 无相关实现（claim≠demo，注水风险）",
            "多模态自相矛盾，一致性差（可靠性 1.5）",
            "审美 rich 与多数采购者偏好 minimal 不符",
        ],
    },
}


def _get_fixture(candidate: CandidateProfile) -> Dict:
    """取 Mock fixture；未知候选按声明数据生成一个确定性降级 fixture。"""
    if candidate.id in MOCK_FIXTURES:
        return MOCK_FIXTURES[candidate.id]
    # 未知候选：基于声明标签给出一个保守默认值（保证可演示）
    tags = candidate.declared_tags
    radar = RadarScore(
        task=3.5,
        quality=3.0,
        comm=3.0,
        creativity=3.0 if "UI" in tags or "React" in tags else 2.5,
        reliability=3.5,
        cost=2.0 if candidate.declared_budget > 200 else 3.5,
    )
    return {
        "radar": radar,
        "verdict": Verdict.OBSERVE,
        "confidence": 0.7,
        "inferred_aesthetic": "neutral",
        "narration": f"{candidate.name} 为基础候选，评估为待观察。",
        "audio_script": f"{candidate.name} 评估完成，判定为待观察。",
        "evidence_trace": ["使用兜底 fixture（未知候选 id）"],
    }


# ======================================================================
# 4) 媒体加载与推理（真实环境实现；骨架中为占位）
# ======================================================================
def load_media(candidate: CandidateProfile) -> Dict:
    """
    加载并预处理多模态证据（架构 §8 多模态约定）：
    - 视频：确定性均匀抽帧（默认 8 帧）
    - 音频：重采样至 16kHz mono
    - 图像：最长边 ≤1024
    骨架中仅返回占位结构；真实环境在此调用 opencv/librosa/Pillow。
    """
    frame_sample = settings.frame_sample
    logger.info(
        "load_media 占位：候选=%s，抽帧数=%d（真实环境将解码视频/音频/图像）",
        candidate.id,
        frame_sample,
    )
    return {
        "frames": frame_sample,
        "audio_loaded": bool(candidate.voice_intro.url),
        "images": len(candidate.artwork),
        "code_lang": candidate.code_repo.lang,
    }


def infer(multimodal: Dict, messages: List[dict]) -> str:
    """
    调用 MiniCPM-o 跨模态推理，返回自由文本（含 JSON）。
    骨架中模型不可用，需由 serve.py 在真实模式下调用。
    """
    raise RuntimeError(
        "infer 需要已加载的 MiniCPM-o 模型；当前为无 NPU 骨架。"
        "请部署到昇腾环境，或在 MOCK=true 下运行。"
    )


# ======================================================================
# 5) 事件流生成
# ======================================================================
def _encode_text(text: str) -> str:
    """文本 → base64（与前端 Mock 模式 audio 事件同字段语义）"""
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


async def _stream_mock(req: EvaluationRequest) -> AsyncGenerator[Dict, None]:
    """Mock 事件流：雷达逐维点亮 → 讲解+语音 → 判定+语音 → done。"""
    candidate = req.candidate
    pref = req.preference
    fixture = _get_fixture(candidate)
    radar: RadarScore = fixture["radar"]

    # 1) 逐维点亮雷达
    for dim in RADAR_DIMS:
        await asyncio.sleep(0.4)
        yield {
            "type": "radar_update",
            "dim": dim,
            "score": float(getattr(radar, dim)),
            "confidence": fixture["confidence"],
            "evidence": (
                fixture["evidence_trace"][0]
                if fixture["evidence_trace"]
                else f"{dim} 由多模态证据推断"
            ),
        }

    # 2) 讲解（按句切分 delta）+ 语音（audio 事件，chunk=base64 文本）
    sentences = re.split(r"(?<=[。！？])", fixture["audio_script"])
    sentences = [s for s in sentences if s.strip()]
    for sent in sentences:
        yield {"type": "narration", "delta": sent, "is_final": False}
        await asyncio.sleep(0.3)
        yield {
            "type": "audio",
            "chunk": _encode_text(sent),
            "format": "wav",
            "sample_rate": 16000,
        }

    # 3) 计算 user_fit
    fit, evidence = compute_user_fit(
        radar,
        pref,
        candidate.declared_budget,
        candidate.declared_tags,
        fixture["inferred_aesthetic"],
    )
    await asyncio.sleep(0.3)
    yield {
        "type": "verdict",
        "verdict": fixture["verdict"].value,
        "user_fit": fit,
        "evidence_trace": fixture["evidence_trace"] + evidence,
        "confidence": fixture["confidence"],
    }

    # 4) 语音宣判
    verdict_text = (
        f"综合判定：{fixture['verdict'].value}。"
        f"{candidate.name} 的用户契合度为 {fit:.0f}%。"
    )
    yield {
        "type": "audio",
        "chunk": _encode_text(verdict_text),
        "format": "wav",
        "sample_rate": 16000,
    }

    await asyncio.sleep(0.2)
    yield {"type": "done", "evaluation_id": f"mock-{candidate.id}-{id(req)}"}


async def _stream_real(req: EvaluationRequest) -> AsyncGenerator[Dict, None]:
    """
    真实事件流（需模型可用）。
    若模型不可用则抛出明确错误（不静默崩溃）。
    """
    model = get_model()
    if not model.available:
        raise RuntimeError(
            "真实推理不可用：模型未加载（无 NPU / 未配置权重）。"
            "请部署到昇腾环境，或设置 MOCK=true。"
        )
    # —— 以下为真实 pipeline 骨架（模型可用时填充）——
    media = load_media(req.candidate)
    messages = build_evaluation_messages(req.candidate, req.preference)
    raw = infer(media, messages)
    parsed = parse_output(raw)

    for dim in RADAR_DIMS:
        yield {
            "type": "radar_update",
            "dim": dim,
            "score": float(getattr(parsed["radar"], dim)),
            "confidence": parsed["confidence"],
            "evidence": (
                parsed["evidence_trace"][0]
                if parsed["evidence_trace"]
                else f"{dim} 由多模态证据推断"
            ),
        }

    # 讲解逐句 + 语音合成
    for sent in re.split(r"(?<=[。！？])", parsed["narration"]):
        if not sent.strip():
            continue
        yield {"type": "narration", "delta": sent, "is_final": False}
        audio_bytes = tts_bridge.synthesize(sent)
        if audio_bytes:
            yield {
                "type": "audio",
                "chunk": base64.b64encode(audio_bytes).decode("ascii"),
                "format": "wav",
                "sample_rate": 16000,
            }

    fit, evidence = compute_user_fit(
        parsed["radar"],
        req.preference,
        req.candidate.declared_budget,
        req.candidate.declared_tags,
        None,
    )
    yield {
        "type": "verdict",
        "verdict": parsed["verdict"].value,
        "user_fit": fit,
        "evidence_trace": parsed["evidence_trace"] + evidence,
        "confidence": parsed["confidence"],
    }
    yield {"type": "done", "evaluation_id": f"real-{req.candidate.id}-{id(req)}"}


async def evaluate(
    req: EvaluationRequest, mode: str = "auto"
) -> AsyncGenerator[Dict, None]:
    """
    评估入口，产出 EvaluationEvent dict 流。

    mode:
      - "mock"：强制 Mock fixture 事件流（无 NPU 演示/测试）。
      - "real"：强制真实推理（模型不可用会抛错）。
      - "auto"（默认）：settings.mock 或模型不可用时走 Mock，否则走真实。
    """
    if mode == "mock":
        async for ev in _stream_mock(req):
            yield ev
        return
    if mode == "real":
        async for ev in _stream_real(req):
            yield ev
        return
    # auto
    model = get_model()
    if settings.mock or not model.available:
        async for ev in _stream_mock(req):
            yield ev
        return
    async for ev in _stream_real(req):
        yield ev
