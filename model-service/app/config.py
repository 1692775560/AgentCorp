"""
model-service/app/config.py
服务配置（环境变量驱动，架构 §2 / §7）。
"""
from __future__ import annotations

import os


class Settings:
    """运行配置，从环境变量读取（支持 .env / docker env）。"""

    def __init__(self) -> None:
        self.model_path: str = os.getenv("MODEL_PATH", "/models/MiniCPM-o-4.5")
        self.device: str = os.getenv("DEVICE", "npu")
        self.host: str = os.getenv("API_HOST", "0.0.0.0")
        self.port: int = int(os.getenv("API_PORT", "8000"))
        self.samples_dir: str = os.getenv("SAMPLES_DIR", "/app/samples")
        self.upload_dir: str = os.getenv("UPLOAD_DIR", "/app/uploads")
        # Mock 模式：无 NPU 时由内置 fixture 生成事件流（与前端一致）
        self.mock: bool = os.getenv("MOCK", "false").lower() in ("1", "true", "yes")
        # 复现控制（架构 D7）
        self.temperature: float = float(os.getenv("TEMPERATURE", "0.0"))
        self.seed: int = int(os.getenv("SEED", "42"))
        self.frame_sample: int = int(os.getenv("FRAME_SAMPLE", "8"))


# 全局单例
settings = Settings()
