"""
model-service/app/model_loader.py
MiniCPM-o 4.5 加载（昇腾 NPU 为部署目标，CPU 兜底；架构 §2 / 适配方案 §2.3、§4.3）。

关键设计：
- 惰性依赖：torch / transformers / torch_npu / flag_gems 一律经 optional_import()
  惰性导入；未安装时 available=False + 明确指引，绝不 ImportError 崩溃。
- 设备选择 resolve_device()：NPU > CUDA > CPU，settings.device（DEVICE 环境变量）
  真正生效；请求的设备不可用时按优先级降级并记 warning。
- 权重路径走 MODEL_PATH（settings.model_path）；路径不存在 → available=False。
- 无 NPU / 无权重 / 缺依赖时不崩溃，由 serve.py /health 与 evaluator 给出明确错误。
"""
from __future__ import annotations

import importlib
import logging
import os
from typing import Any, Optional

from .config import settings

logger = logging.getLogger("model_loader")

# 可选推理依赖的安装指引（写进日志/错误信息，保持单处维护）
INSTALL_HINT = (
    "pip install 'transformers==4.51.0' accelerate 'torch>=2.3.0,<=2.8.0' "
    "'torchaudio<=2.8.0' 'minicpmo-utils[all]>=1.0.5' librosa"
    "（昇腾环境另需与 CANN 版本匹配的 torch_npu 或 FlagOS flag_gems，"
    "详见 docs/ascend-adaptation-plan.md §3.2）"
)


def optional_import(name: str) -> Any:
    """惰性导入可选依赖；未安装时返回 None（不抛 ImportError）。"""
    try:
        return importlib.import_module(name)
    except ImportError:
        return None


class MiniCPMModel:
    """轻量包装：真实推理时持有 model + processor；不可用时 available=False。"""

    def __init__(
        self,
        model: Any = None,
        processor: Any = None,
        available: bool | None = None,
        device: str = "",
    ) -> None:
        self.model = model
        self.processor = processor
        # 两种调用风格兼容：显式传 available 时以显式值为准；
        # 否则按「是否持有真实 model」推断（无参构造 = 占位不可用）。
        self.available = (model is not None) if available is None else available
        # 实际加载到的设备（npu / cuda / cpu）；未加载为空串
        self.device = device


def _npu_available(torch_mod: Any) -> bool:
    """NPU 可用判定：torch_npu 可导入且 torch.npu.is_available()。"""
    if optional_import("torch_npu") is None:
        return False
    npu = getattr(torch_mod, "npu", None)
    if npu is None:
        return False
    try:
        return bool(npu.is_available())
    except Exception:  # noqa: BLE001 - npu 探测失败按不可用处理
        return False


def _cuda_available(torch_mod: Any) -> bool:
    cuda = getattr(torch_mod, "cuda", None)
    if cuda is None:
        return False
    try:
        return bool(cuda.is_available())
    except Exception:  # noqa: BLE001
        return False


def resolve_device(torch_mod: Any = None) -> str:
    """
    设备选择：NPU > CUDA > CPU，settings.device（DEVICE 环境变量）生效。

    - "npu"：优先 NPU，不可用则降级 CUDA → CPU（记 warning）；
    - "cuda"：CUDA 不可用时降级 CPU（记 warning）；
    - "cpu"：强制 CPU；
    - "auto"（或其他未识别值）：按 NPU > CUDA > CPU 自动选择。
    torch 未安装时直接返回 "cpu"（由调用方决定继续或降级）。
    """
    requested = (settings.device or "auto").lower()
    if torch_mod is None:
        torch_mod = optional_import("torch")
    if torch_mod is None:
        logger.warning("torch 未安装，设备选择返回 cpu（真实加载将不可用）")
        return "cpu"

    npu_ok = _npu_available(torch_mod)
    cuda_ok = _cuda_available(torch_mod)

    if requested == "npu":
        if npu_ok:
            return "npu"
        logger.warning("DEVICE=npu 但 NPU 不可用（缺 torch_npu 或无昇腾设备），尝试降级")
    elif requested == "cuda":
        if cuda_ok:
            return "cuda"
        logger.warning("DEVICE=cuda 但 CUDA 不可用，降级 CPU")
        return "cpu"
    elif requested == "cpu":
        return "cpu"
    elif requested != "auto":
        logger.warning("未识别的 DEVICE=%r，按 auto 处理", settings.device)

    # auto / npu 降级路径：NPU > CUDA > CPU
    if npu_ok:
        return "npu"
    if cuda_ok:
        return "cuda"
    return "cpu"


def to_npu(model: Any, device: Optional[str] = None) -> Any:
    """
    将模型搬到目标设备（默认 resolve_device()：NPU > CUDA > CPU）。
    函数名保留兼容；真实实现为 model.to(device)。
    """
    target = device or resolve_device()
    return model.to(target)


def load_minicpmo(model_path: Optional[str] = None) -> MiniCPMModel:
    """
    真实加载 MiniCPM-o 4.5（官方用法：transformers + trust_remote_code）。

    任一前置条件不满足（缺依赖 / 权重不存在 / 加载异常）均优雅降级为
    available=False 并记日志，不崩溃——与 /health、evaluator 的 503 逻辑衔接。
    """
    model_path = model_path or settings.model_path

    torch = optional_import("torch")
    transformers = optional_import("transformers")
    if torch is None or transformers is None:
        logger.warning(
            "MiniCPM-o 真实推理依赖未安装（torch/transformers）。"
            "返回不可用模型；安装后重试：%s",
            INSTALL_HINT,
        )
        return MiniCPMModel()

    if not os.path.isdir(model_path):
        logger.warning(
            "MiniCPM-o 权重目录不存在：%s（经 MODEL_PATH 环境变量配置）。"
            "返回不可用模型；权重获取见 docs/ascend-adaptation-plan.md §4.1。",
            model_path,
        )
        return MiniCPMModel()

    try:
        device = resolve_device(torch)
        if device == "npu":
            # 昇腾后端：flag_gems（FlagOS，import 即生效）或 torch_npu（官方主推）
            backend = os.getenv("ASCEND_BACKEND", "torch_npu")
            if backend == "flag_gems":
                importlib.import_module("flag_gems")
            else:
                importlib.import_module("torch_npu")

        model = transformers.AutoModel.from_pretrained(
            model_path,
            trust_remote_code=True,
            attn_implementation="sdpa",
            torch_dtype=torch.float32 if device == "cpu" else torch.bfloat16,
            init_vision=True,
            init_audio=True,
            init_tts=True,
        )
        model.eval()
        model = to_npu(model, device)
        try:
            # 音频输出（TTS）能力初始化；失败仅影响 TTS，不影响文本推理
            model.init_tts()
        except Exception as exc:  # noqa: BLE001
            logger.warning("init_tts 失败（仅影响语音输出）：%s", exc)

        tokenizer = transformers.AutoTokenizer.from_pretrained(
            model_path, trust_remote_code=True
        )
        logger.info("MiniCPM-o 4.5 加载完成：device=%s，path=%s", device, model_path)
        return MiniCPMModel(model=model, processor=tokenizer, device=device)
    except Exception as exc:  # noqa: BLE001
        logger.error("模型加载失败（%s）：%s", model_path, exc)
        return MiniCPMModel()


_model: Optional[MiniCPMModel] = None


def get_model() -> MiniCPMModel:
    """全局懒加载（单例）。"""
    global _model
    if _model is None:
        _model = load_minicpmo(settings.model_path)
    return _model
