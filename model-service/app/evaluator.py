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
import hashlib
import json
import logging
import os
import re
from typing import AsyncGenerator, Dict, List, Optional

from .config import settings
from .model_loader import get_model, optional_import
from .prompt_templates import build_evaluation_messages
from .schemas import (
    Aesthetic,
    CandidateProfile,
    EvaluationRequest,
    JudgeRunRequest,
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

# 六维中文名（讲解稿 / 语音播报用）
DIM_LABELS: Dict[str, str] = {
    "task": "任务完成",
    "quality": "产出质量",
    "comm": "沟通协作",
    "creativity": "创造泛化",
    "reliability": "稳定可靠",
    "cost": "性价比",
}

_VERDICT_LABELS: Dict[str, str] = {
    "MVP": "MVP",
    "OBSERVE": "待观察",
    "FIRED": "You are fired",
}


# ======================================================================
# 1) 用户契合度计算（与前端 src/utils/radar.ts 严格一致）
# ======================================================================
def compute_user_fit(
    radar: RadarScore,
    preference: UserPreference,
    declared_budget: float,
    declared_tags: List[str],
    inferred_aesthetic: Optional[str] = None,
    subjective: Optional[Dict[str, float]] = None,
    cap_percent: float = 8.0,
    **kwargs,
) -> tuple[float, List[str]]:
    """
    user_fit = Σ(radar[dim]/5 × weight[dim]) × 100%
    叠加：预算硬约束（超预算则 cost 权重清零）、
         审美硬约束（不符 -8% / 相符 +2%）、技术栈加分（命中 ×1.5%，上限 6%）。
    结果裁剪至 [0,100]。

    T3 扩展（向后兼容，不传 subjective 时行为完全不变）：
    若传入 subjective（{dim: 0-5}），按 owner 决策 Q3 叠加「owner 口味修正」：
      delta = clamp( mean((score-3)/5 for score in subjective) , ±capPercent% )
      user_fit = user_fit × (1 + delta)    # 乘法形式，capPercent 默认 8 → ±0.08
    即主观分只做 ±8% 封顶的 owner 口味修正，不颠覆客观结论。
    cap_percent 可由规则 subjective.capPercent 传入（默认 8）。
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

    # T3：主观叠加（owner 口味修正，封顶 ±capPercent%，向后兼容）
    if subjective:
        cap = cap_percent / 100.0  # 8 → 0.08（±8%）
        vals = [float(v) for v in subjective.values()]
        if vals:
            # 各维偏离中性值 3 的差值归一（÷5），再取均值 → 分数（-0.6 ~ 0.4）
            avg_dev = sum((v - 3.0) / 5.0 for v in vals) / len(vals)
            delta = max(-cap, min(cap, avg_dev))  # clamp ±capPercent%
            fit = fit * (1.0 + delta)
            evidence.append(
                f"主观叠加(sub_avg_dev={avg_dev:.3f})→{delta:+.3f}（封顶 ±{cap_percent:.0f}%）"
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

    # T2/T3：craft 子对象解析（工种专属维 img_*/txt_*/code_*，0–5）。
    # 架构 R4：缺 craft 子对象时降级为空 dict + 标记，不抛异常（向后兼容）。
    craft_raw = data.get("craft")
    craft = craft_raw if isinstance(craft_raw, dict) else {}
    craft_missing = "craft" not in data

    return {
        "radar": radar,
        "verdict": verdict,
        "confidence": confidence,
        "evidence_trace": evidence,
        "narration": narration,
        "audio_script": audio_script,
        "craft": craft,
        "craft_missing": craft_missing,
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
# 4) 媒体加载与推理（真实实现；缺文件/缺依赖优雅降级，不中断评估）
# ======================================================================
def _resolve_media_path(url: str) -> Optional[str]:
    """
    将媒体 URL 解析为本地文件路径：
    - "/uploads/..."（/api/upload 落盘的静态前缀）→ settings.upload_dir 下；
    - http(s) 远程 URL → 不抓取，返回 None（记日志跳过）；
    - 其余按文件系统路径处理。
    """
    if not url:
        return None
    if url.startswith("http://") or url.startswith("https://"):
        logger.info("远程媒体 URL 不抓取（按本地部署约定）：%s", url[:80])
        return None
    if url.startswith("/uploads/"):
        return os.path.join(settings.upload_dir, url[len("/uploads/"):])
    return url


def _load_image(path: str) -> Optional[object]:
    """PIL 加载图像（RGB，最长边 ≤1024）；失败返回 None。"""
    pil_image = optional_import("PIL.Image")
    if pil_image is None:
        logger.warning("Pillow 未安装，跳过图像加载：%s", path)
        return None
    try:
        img = pil_image.open(path).convert("RGB")
        img.thumbnail((1024, 1024))
        return img
    except Exception as exc:  # noqa: BLE001
        logger.warning("图像加载失败（跳过）：%s：%s", path, exc)
        return None


def _load_audio(path: str) -> Optional[object]:
    """librosa 加载音频（16kHz mono numpy 波形，与官方用法一致）；失败返回 None。"""
    librosa = optional_import("librosa")
    if librosa is None:
        logger.warning("librosa 未安装，跳过音频加载：%s", path)
        return None
    try:
        y, _sr = librosa.load(path, sr=16000, mono=True)
        return y
    except Exception as exc:  # noqa: BLE001
        logger.warning("音频加载失败（跳过）：%s：%s", path, exc)
        return None


def _sample_video_frames(path: str, n_frames: int) -> List[object]:
    """opencv 均匀抽帧（BGR→RGB→PIL）；cv2 缺失或失败返回空列表。"""
    cv2 = optional_import("cv2")
    pil_image = optional_import("PIL.Image")
    if cv2 is None or pil_image is None:
        logger.warning("opencv-python 未安装，跳过视频抽帧：%s", path)
        return []
    cap = cv2.VideoCapture(path)
    try:
        if not cap.isOpened():
            logger.warning("视频无法打开（跳过）：%s", path)
            return []
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
        if total <= 0:
            return []
        n = max(1, min(n_frames, total))
        # 均匀抽帧：首尾对齐，索引确定性（复现性）
        indices = [round(i * (total - 1) / (n - 1)) if n > 1 else 0 for i in range(n)]
        frames = []
        for idx in indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, bgr = cap.read()
            if not ok:
                continue
            frames.append(pil_image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)))
        return frames
    except Exception as exc:  # noqa: BLE001
        logger.warning("视频抽帧失败（跳过）：%s：%s", path, exc)
        return []
    finally:
        cap.release()


def load_media(candidate: CandidateProfile) -> Dict:
    """
    加载并预处理多模态证据（架构 §8 多模态约定）：
    - 视频：确定性均匀抽帧（settings.frame_sample，默认 8 帧）
    - 音频：重采样至 16kHz mono（librosa，numpy 波形）
    - 图像：最长边 ≤1024（PIL）

    返回真实载荷 dict：frames: List[PIL.Image]，audio: np.ndarray|None，
    images: List[PIL.Image]，code_lang: str。
    文件不存在 / 依赖缺失时优雅降级为空媒体 + warning 日志，不中断评估。
    """
    frames: List[object] = []
    video_path = _resolve_media_path(candidate.video_demo.url)
    if video_path:
        if os.path.isfile(video_path):
            frames = _sample_video_frames(video_path, settings.frame_sample)
        else:
            logger.warning("视频文件不存在（跳过）：%s", video_path)

    audio = None
    audio_path = _resolve_media_path(candidate.voice_intro.url)
    if audio_path:
        if os.path.isfile(audio_path):
            audio = _load_audio(audio_path)
        else:
            logger.warning("音频文件不存在（跳过）：%s", audio_path)

    images: List[object] = []
    for ref in candidate.artwork:
        img_path = _resolve_media_path(ref.url)
        if not img_path:
            continue
        if not os.path.isfile(img_path):
            logger.warning("作品图不存在（跳过）：%s", img_path)
            continue
        img = _load_image(img_path)
        if img is not None:
            images.append(img)

    logger.info(
        "load_media：候选=%s，帧=%d，音频=%s，图像=%d",
        candidate.id,
        len(frames),
        "已加载" if audio is not None else "无",
        len(images),
    )
    return {
        "frames": frames,
        "audio": audio,
        "images": images,
        "code_lang": candidate.code_repo.lang,
    }


def infer(multimodal: Dict, messages: List[dict]) -> str:
    """
    调用 MiniCPM-o 跨模态推理（官方 chat API），返回自由文本（含 JSON）。

    将 load_media 的真实载荷（帧 / 音频波形 / 图像）并入 user 消息 content
    列表（官方约定：PIL 图像 / numpy 音频 / str 混合），含媒体时 omni_mode=True。
    do_sample 由 settings.temperature 决定（0 → 贪心解码，保证复现性）。

    模型未加载时抛 RuntimeError，含明确指引（安装依赖 / 配置权重 / MOCK=true）。
    """
    wrapper = get_model()
    if not wrapper.available:
        raise RuntimeError(
            "infer 需要已加载的 MiniCPM-o 模型，但当前模型不可用"
            "（缺推理依赖 / 权重未就位 / 无可用设备）。请任选其一："
            "1) 安装可选推理依赖并配置 MODEL_PATH（见 requirements.txt 注释与 README）；"
            "2) 部署到昇腾环境（DEVICE=npu）；"
            "3) 设置 MOCK=true 走演示事件流。"
        )

    content: List[object] = []
    content.extend(multimodal.get("frames") or [])
    if multimodal.get("audio") is not None:
        content.append(multimodal["audio"])
    content.extend(multimodal.get("images") or [])
    has_media = bool(content)

    msgs: List[dict] = []
    for msg in messages:
        if msg.get("role") == "user" and isinstance(msg.get("content"), str):
            msgs.append({"role": "user", "content": content + [msg["content"]]})
        else:
            msgs.append(msg)

    do_sample = settings.temperature > 0
    kwargs: Dict = {
        "msgs": msgs,
        "do_sample": do_sample,
        "enable_thinking": False,
        "max_new_tokens": 2048,
    }
    if do_sample:
        kwargs["temperature"] = settings.temperature
    if has_media:
        # 官方约定：含音视频输入的 omni 推理必须 omni_mode=True
        kwargs["omni_mode"] = True

    res = wrapper.model.chat(**kwargs)
    if isinstance(res, str):
        return res
    # 防御：个别版本流式/分片返回时拼接文本
    if isinstance(res, (list, tuple)):
        return "".join(str(r) for r in res)
    return str(res)


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


# ======================================================================
# 6) 运行期裁判（/api/evaluate-run）：transcript + usage → 同构 SSE 流
# ======================================================================
def _clamp(value: float, lo: float = 0.0, hi: float = 5.0) -> float:
    return max(lo, min(hi, value))


def _derive_run_radar(req: JudgeRunRequest) -> RadarScore:
    """
    Mock 回退：基于真实 usage（成本）+ agent_id 确定性哈希派生六维雷达。
    成本维直接由真实总花费折算（预算 1.0 USD 为基准，越低越高分）；
    其余维由 agent_id 哈希确定，保证可复现演示。
    """
    usage = req.usage or []
    total_cost = sum(float(u.get("costUsd", 0) or 0) for u in usage)
    h = int(hashlib.md5(req.agent_id.encode("utf-8")).hexdigest(), 16)

    def jitter(shift: int, base: float) -> float:
        return base + ((h >> shift) % 1000) / 1000.0 * 2.0

    task = jitter(0, 3.0)
    quality = jitter(3, 3.0)
    comm = jitter(6, 2.5)
    creativity = jitter(9, 2.5)
    reliability = jitter(12, 3.0)
    cost_score = 5.0 - (total_cost / 1.0) * 5.0
    cost = cost_score if total_cost > 0 else 3.0

    return RadarScore(
        task=_clamp(task),
        quality=_clamp(quality),
        comm=_clamp(comm),
        creativity=_clamp(creativity),
        reliability=_clamp(reliability),
        cost=_clamp(cost),
    )


def _verdict_from_radar(radar: RadarScore) -> Verdict:
    avg = sum(getattr(radar, d) for d in RADAR_DIMS) / len(RADAR_DIMS)
    if avg >= 4.0:
        return Verdict.MVP
    if avg >= 2.5:
        return Verdict.OBSERVE
    return Verdict.FIRED


def _default_pref() -> UserPreference:
    return UserPreference()


def _build_run_prompt(req: JudgeRunRequest) -> str:
    """将 transcript + usage + task 拼为模型推理提示词。"""
    usage = req.usage or []
    total_tokens = sum(int(u.get("totalTokens", 0) or 0) for u in usage)
    total_cost = sum(float(u.get("costUsd", 0) or 0) for u in usage)
    transcript = (req.transcript or "").strip()
    snippet = transcript[:4000] if transcript else "(无转录)"
    return (
        f"评估 agent：{req.agent_name or req.agent_id}\n"
        f"任务：{req.task.title}（{req.task.description}）\n"
        f"真实用量：tokens={total_tokens}，cost=${total_cost:.4f}，样本数={len(usage)}\n"
        f"转录片段：\n{snippet}\n\n"
        "请基于上述真实运行数据，输出 JSON："
        "{\"radar\":{task,quality,comm,creativity,reliability,cost},"
        "\"verdict\":\"MVP|OBSERVE|FIRED\",\"confidence\":0-1,"
        "\"evidence_trace\":[...],\"narration\":\"...\"}"
    )


def _build_run_narration(req: JudgeRunRequest, radar: RadarScore, verdict: Verdict) -> str:
    """由雷达 + 判定生成中文讲解稿（mock-run 语音闭环用）。"""
    name = req.agent_name or req.agent_id
    scores = {d: float(getattr(radar, d)) for d in RADAR_DIMS}
    strongest = max(scores, key=lambda d: scores[d])
    weakest = min(scores, key=lambda d: scores[d])
    return (
        f"{name} 的六维评估已完成。"
        f"最强维度是{DIM_LABELS[strongest]}（{scores[strongest]:.1f} 分），"
        f"最弱维度是{DIM_LABELS[weakest]}（{scores[weakest]:.1f} 分）。"
        f"综合判定为{_VERDICT_LABELS[verdict.value]}。"
    )


async def _stream_mock_run(req: JudgeRunRequest) -> AsyncGenerator[Dict, None]:
    """Mock 运行期裁判流：雷达逐维点亮 → 讲解/语音 → 判定 → 语音宣判 → done。"""
    radar = _derive_run_radar(req)
    for dim in RADAR_DIMS:
        await asyncio.sleep(0.3)
        yield {
            "type": "radar_update",
            "dim": dim,
            "score": float(getattr(radar, dim)),
            "confidence": 0.85,
            "evidence": f"{dim} 由真实用量/画像派生（mock 回退）",
        }

    verdict = _verdict_from_radar(radar)
    avg = sum(getattr(radar, d) for d in RADAR_DIMS) / len(RADAR_DIMS)
    user_fit = round(avg * 20, 1)

    # 讲解（逐句 narration delta）+ 语音（audio 事件，chunk=base64 UTF-8 文本）
    # 注意：audio 必须先于本句 narration 发出——渲染层见到首个 audio 后才把
    # narration 降级为「只上屏不播报」，先发 narration 会导致首句被双播。
    narration = _build_run_narration(req, radar, verdict)
    sentences = [s for s in re.split(r"(?<=[。！？])", narration) if s.strip()]
    for sent in sentences:
        yield {
            "type": "audio",
            "chunk": _encode_text(sent),
            "format": "wav",
            "sample_rate": 16000,
        }
        await asyncio.sleep(0.2)
        yield {"type": "narration", "delta": sent, "is_final": False}
    yield {"type": "narration", "delta": "", "is_final": True}

    total_cost = sum(float(u.get("costUsd", 0) or 0) for u in (req.usage or []))
    await asyncio.sleep(0.3)
    yield {
        "type": "verdict",
        "verdict": verdict.value,
        "user_fit": user_fit,
        "evidence_trace": [
            f"total_cost≈${total_cost:.4f}",
            f"avg_radar={avg:.2f}",
            f"source=mock-run（MOCK=true 或模型不可用）",
        ],
        "confidence": 0.85,
    }

    # 语音宣判
    verdict_text = (
        f"综合判定：{_VERDICT_LABELS[verdict.value]}。"
        f"用户契合度 {user_fit:.0f}%。"
    )
    yield {
        "type": "audio",
        "chunk": _encode_text(verdict_text),
        "format": "wav",
        "sample_rate": 16000,
    }

    await asyncio.sleep(0.2)
    yield {"type": "done", "evaluation_id": f"mock-run-{req.agent_id}-{id(req)}"}


async def _stream_real_run(req: JudgeRunRequest) -> AsyncGenerator[Dict, None]:
    """真实运行期裁判流（需模型可用）。含讲解 narration；tts 可用时附 audio。"""
    model = get_model()
    if not model.available:
        raise RuntimeError("真实推理不可用：模型未加载（无 NPU / 未配置权重）。请设置 MOCK=true。")
    messages = [{"role": "user", "content": _build_run_prompt(req)}]
    media = {"transcript": req.transcript, "usage": req.usage}
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
                else f"{dim} 由模型推断"
            ),
        }

    # 讲解（逐句 narration delta）+ 语音（tts 字节；不可用时仅 narration）
    # audio 先于本句 narration 发出，理由同 _stream_mock_run（防首句双播）。
    narration = parsed["audio_script"] or parsed["narration"]
    for sent in re.split(r"(?<=[。！？])", narration):
        if not sent.strip():
            continue
        audio_bytes = tts_bridge.synthesize(sent)
        if audio_bytes:
            yield {
                "type": "audio",
                "chunk": base64.b64encode(audio_bytes).decode("ascii"),
                "format": "wav",
                "sample_rate": 16000,
            }
        yield {"type": "narration", "delta": sent, "is_final": False}
    yield {"type": "narration", "delta": "", "is_final": True}

    fit, evidence = compute_user_fit(parsed["radar"], _default_pref(), 200.0, [], None)
    yield {
        "type": "verdict",
        "verdict": parsed["verdict"].value,
        "user_fit": fit,
        "evidence_trace": parsed["evidence_trace"] + evidence,
        "confidence": parsed["confidence"],
    }

    # 语音宣判（tts 可用时）
    verdict_text = (
        f"综合判定：{_VERDICT_LABELS.get(parsed['verdict'].value, parsed['verdict'].value)}。"
        f"用户契合度 {fit:.0f}%。"
    )
    verdict_audio = tts_bridge.synthesize(verdict_text)
    if verdict_audio:
        yield {
            "type": "audio",
            "chunk": base64.b64encode(verdict_audio).decode("ascii"),
            "format": "wav",
            "sample_rate": 16000,
        }

    yield {"type": "done", "evaluation_id": f"real-run-{req.agent_id}-{id(req)}"}


async def evaluate_run(
    req: JudgeRunRequest, mode: str = "auto"
) -> AsyncGenerator[Dict, None]:
    """
    运行期裁判入口，产出与 /api/evaluate 同构的 EvaluationEvent dict 流
    （radar_update ×6 + verdict + done）。

    mode：
      - "mock"：强制 Mock 派生（无 NPU 演示/测试）。
      - "real"：强制真实推理（模型不可用会抛错）。
      - "auto"（默认）：settings.mock 或模型不可用时走 Mock，否则走真实。
    """
    if mode == "mock":
        async for ev in _stream_mock_run(req):
            yield ev
        return
    if mode == "real":
        async for ev in _stream_real_run(req):
            yield ev
        return
    model = get_model()
    if settings.mock or not model.available:
        async for ev in _stream_mock_run(req):
            yield ev
        return
    async for ev in _stream_real_run(req):
        yield ev
