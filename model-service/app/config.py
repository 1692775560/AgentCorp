"""
model-service/app/config.py
服务配置（环境变量驱动。
"""
from __future__ import annotations

import os


class Settings:
    """运行配置，从环境变量读取（支持 .env / docker env）。"""

    def __init__(self) -> None:
        self.model_path: str = os.getenv("MODEL_PATH", "/models/MiniCPM-o-4.5")
        # auto：按 NPU > CUDA > CPU 自动探测（见 model_loader.resolve_device）。
        # 不默认 npu —— 绝大多数机器上那是个必然失败的默认值，会让首次运行者
        # 误以为是代码问题；显式声明 DEVICE=npu 才走异构加速卡路径。
        self.device: str = os.getenv("DEVICE", "auto")
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

        # ===== LLM-as-judge 推理后端（judge_backend.py）=====
        # http  —— OpenAI 兼容服务（vLLM-Omni / OpenBMB API），无 NPU 也能真实评测
        # local —— 本机 transformers 推理，device 见上方 self.device（cuda/cpu/npu）
        # mock  —— 不提供推理，调用方降级（绝不伪造分数）
        self.judge_backend: str = os.getenv("JUDGE_BACKEND", "mock").lower()
        self.judge_base_url: str = os.getenv("JUDGE_BASE_URL", "")
        self.judge_api_key: str = os.getenv("JUDGE_API_KEY", "")
        self.judge_model: str = os.getenv("JUDGE_MODEL", "MiniCPM-o-4.5")
        self.judge_max_tokens: int = int(os.getenv("JUDGE_MAX_TOKENS", "1536"))
        self.judge_timeout: float = float(os.getenv("JUDGE_TIMEOUT", "120"))

        # ===== ensemble 采样（重复测量要真的有扰动才有意义）=====
        # 单点评分 temperature=0 保证可复现；但 ensemble 的 k 次重复若也用 0，
        # k 次输出逐字相同，pass^k 就退化成 pass^1 的复读，离散度警报永远不会响。
        # 因此 ensemble 路径单独使用一个 >0 的温度做真实重复采样。
        self.judge_ensemble_temperature: float = float(
            os.getenv("JUDGE_ENSEMBLE_TEMPERATURE", "0.5")
        )
        # 跨家族裁判池（逗号分隔）。配置 ≥2 个不同家族的模型后，
        # ensemble 的第 i 次采样会轮转到第 i 个模型 —— 这是对「自我增强偏差」
        # 唯一有效的结构性缓解：让裁判不总是与被评方同源。
        # 缺省回退单一 judge_model（行为与此前一致）。
        self.judge_models: list = [
            m.strip() for m in os.getenv("JUDGE_MODELS", "").split(",") if m.strip()
        ]

        # ===== 代码沙盒（sandbox/runner.py）=====
        # 真实执行候选给出的代码与测试，为 code_runnability 产出机器可核验证据。
        # 默认关闭：它会在本机执行来自候选 agent 的代码，必须由部署者显式授权。
        self.sandbox_enabled: bool = os.getenv("SANDBOX_ENABLED", "false").lower() in (
            "1",
            "true",
            "yes",
        )
        self.sandbox_timeout: float = float(os.getenv("SANDBOX_TIMEOUT", "10"))
        self.sandbox_mem_mb: int = int(os.getenv("SANDBOX_MEM_MB", "512"))

        # ===== 候选跑题通道（candidate_runner.py，A2/A3）=====
        # text    —— 直接使用调用方提供的答案文本（A3 演示/人工模式）
        # gateway —— 经 OpenClaw gateway 的 OpenAI 兼容 chat 调度（A2 真实跑题）
        self.candidate_channel: str = os.getenv("CANDIDATE_CHANNEL", "text").lower()
        self.gateway_base_url: str = os.getenv("GATEWAY_BASE_URL", "")
        self.gateway_model: str = os.getenv("GATEWAY_MODEL", "MiniCPM-o-4.5")
        self.gateway_api_key: str = os.getenv("GATEWAY_API_KEY", "")
        self.candidate_timeout: float = float(os.getenv("CANDIDATE_TIMEOUT", "120"))


# 全局单例
settings = Settings()
