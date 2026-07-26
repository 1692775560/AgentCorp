"""
model-service/app/model_loader.py
MiniCPM-o 4.5 加载到昇腾 NPU（架构 §2）。

关键：优雅降级。无 NPU / 无权重 / 缺依赖时，
不崩溃，返回 available=False 的占位模型，由 serve.py 给出明确错误。
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from .config import settings

logger = logging.getLogger("model_loader")


class MiniCPMModel:
    """轻量包装：真实推理时持有 model + processor；不可用时 available=False。"""

    def __init__(self, model: Any = None, processor: Any = None) -> None:
        self.model = model
        self.processor = processor
        self.available = model is not None


_model: Optional[MiniCPMModel] = None


def load_minicpmo(model_path: str) -> MiniCPMModel:
    """
    加载 MiniCPM-o 4.5 到 NPU。

    真实环境（取消注释并按官方 starter kit 适配）：
        from transformers import AutoModel, AutoProcessor
        import torch
        model = AutoModel.from_pretrained(
            model_path, trust_remote_code=True, attn_implementation="sdpa"
        ).to("npu")
        processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)

    本骨架在无 NPU 环境下返回不可用模型，便于本地运行/测试。
    """
    try:
        # —— 真实加载（需 torch_npu / transformers，缺省不阻塞骨架）——
        # from transformers import AutoModel, AutoProcessor
        # import torch
        # model = AutoModel.from_pretrained(model_path, trust_remote_code=True).to("npu")
        # processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
        # return MiniCPMModel(model=model, processor=processor)
        logger.warning(
            "MiniCPM-o 权重未在当前环境加载（无 NPU / 未配置权重）。"
            "返回不可用模型；推理将报错或走 Mock。部署到昇腾环境后自动启用真实推理。"
        )
        return MiniCPMModel(available=False)
    except Exception as exc:  # noqa: BLE001
        logger.error("模型加载失败：%s", exc)
        return MiniCPMModel(available=False)


def to_npu(model: Any) -> Any:
    """将模型搬到 NPU（真实环境实现；此处透传）。"""
    return model


def get_model() -> MiniCPMModel:
    """全局懒加载（单例）。"""
    global _model
    if _model is None:
        _model = load_minicpmo(settings.model_path)
    return _model
