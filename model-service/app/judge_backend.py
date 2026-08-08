"""
model-service/app/judge_backend.py
LLM-as-judge 推理后端抽象层（HR 面试评测的唯一推理入口）。

为什么需要这一层：evaluator.infer() 原先直接 raise，导致「真实评测」这条路
从未存在，所有分数都来自 mock 或启发式。本模块把推理收敛为一个接口 + 三实现，
让同一套评分管线在三种环境下都能跑：

  http   —— OpenAI 兼容 /chat/completions，指向 MiniCPM-o 的 vLLM / OpenBMB 服务。
            无 NPU 的开发机可用它做真实验证。
  local  —— 昇腾本机 transformers + torch_npu，device 取自 settings.device。
            大赛统一环境走这条（「性能可复现」）。
  mock   —— 明确不可用（available=False），由调用方降级，绝不伪造分数。

零新增依赖：HTTP 走标准库 urllib，不引入 requests/httpx。
所有后端都返回 JudgeCompletion，内含 ttft_ms / latency_ms，
直接满足昇腾大赛的首响与端到端延迟指标要求。
"""
from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Protocol, runtime_checkable

from .config import settings

logger = logging.getLogger("judge_backend")


class JudgeUnavailable(RuntimeError):
    """后端不可用（未配置 / 依赖缺失 / 服务不可达）。调用方据此降级。"""


@dataclass
class JudgeCompletion:
    """一次推理的产出与性能指标（指标供大赛「性能可复现」口径）。"""

    text: str
    backend: str
    model: str = ""
    #  首个 token 到达耗时（ms）。非流式请求下等于 latency_ms。
    ttft_ms: Optional[float] = None
    #  端到端耗时（ms）
    latency_ms: float = 0.0
    #  上游返回的 token 用量（有则透传，供成本维使用）
    usage: Dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class JudgeBackend(Protocol):
    """推理后端契约：只负责 messages → 文本，不理解评分语义。"""

    name: str

    @property
    def available(self) -> bool:
        ...

    def complete(
        self,
        messages: List[dict],
        *,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> JudgeCompletion:
        ...


# ======================================================================
# 1) HTTP 后端（OpenAI 兼容，指向 MiniCPM-o 推理服务）
# ======================================================================
class HttpJudgeBackend:
    """
    OpenAI 兼容 /chat/completions 客户端（标准库实现）。

    适配 vLLM-Omni、OpenBMB 官方 API 及任何兼容网关。
    仅当 settings.judge_base_url 非空时可用。
    """

    name = "http"

    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str = "",
        timeout: float = 120.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout

    @property
    def available(self) -> bool:
        return bool(self.base_url and self.model)

    def complete(
        self,
        messages: List[dict],
        *,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> JudgeCompletion:
        if not self.available:
            raise JudgeUnavailable("未配置 JUDGE_BASE_URL / JUDGE_MODEL")

        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": settings.temperature if temperature is None else temperature,
            "max_tokens": settings.judge_max_tokens if max_tokens is None else max_tokens,
            "stream": False,
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=body,
            headers=headers,
            method="POST",
        )
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise JudgeUnavailable(f"judge HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise JudgeUnavailable(f"judge 不可达：{exc}") from exc

        elapsed_ms = (time.perf_counter() - started) * 1000.0
        try:
            data = json.loads(raw)
            text = data["choices"][0]["message"]["content"]
        except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
            raise JudgeUnavailable(f"judge 响应结构异常：{exc}") from exc

        return JudgeCompletion(
            text=str(text),
            backend=self.name,
            model=self.model,
            ttft_ms=elapsed_ms,
            latency_ms=elapsed_ms,
            usage=data.get("usage") or {},
        )


# ======================================================================
# 2) 昇腾本地后端（transformers + torch_npu）
# ======================================================================
class LocalJudgeBackend:
    """
    本机权重推理，device 取自 settings.device（npu / cuda / cpu）。

    依赖 torch / transformers，缺失时 available=False，
    不在 import 期抛错（保证无 NPU 机器仍可 import 本模块）。
    """

    name = "local"

    def __init__(self, model_path: str, device: str) -> None:
        self.model_path = model_path
        self.device = device
        self._model: Any = None
        self._tokenizer: Any = None
        self._load_error: Optional[str] = None

    def _ensure_loaded(self) -> None:
        if self._model is not None or self._load_error is not None:
            return
        try:
            import torch  # noqa: F401
            from transformers import AutoModel, AutoTokenizer

            if self.device.startswith("npu"):
                # torch_npu 注册 npu 设备，必须在 .to("npu") 之前 import
                import torch_npu  # noqa: F401

            model = AutoModel.from_pretrained(
                self.model_path, trust_remote_code=True
            ).eval()
            self._model = model.to(self.device)
            self._tokenizer = AutoTokenizer.from_pretrained(
                self.model_path, trust_remote_code=True
            )
            logger.info("MiniCPM-o 已加载到 %s", self.device)
        except Exception as exc:  # noqa: BLE001 —— 依赖缺失/权重缺失/设备不可用统一降级
            self._load_error = str(exc)
            logger.warning("本地 judge 后端不可用：%s", exc)

    @property
    def available(self) -> bool:
        self._ensure_loaded()
        return self._model is not None

    def complete(
        self,
        messages: List[dict],
        *,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> JudgeCompletion:
        self._ensure_loaded()
        if self._model is None:
            raise JudgeUnavailable(f"本地模型未加载：{self._load_error}")

        temp = settings.temperature if temperature is None else temperature
        started = time.perf_counter()
        # MiniCPM-o 系列暴露 .chat(msgs=..., tokenizer=...) 接口
        text = self._model.chat(
            msgs=messages,
            tokenizer=self._tokenizer,
            sampling=temp > 0,
            temperature=temp,
            max_new_tokens=settings.judge_max_tokens if max_tokens is None else max_tokens,
        )
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        if isinstance(text, (list, tuple)):
            text = text[0] if text else ""
        return JudgeCompletion(
            text=str(text),
            backend=self.name,
            model=self.model_path,
            ttft_ms=elapsed_ms,
            latency_ms=elapsed_ms,
        )


# ======================================================================
# 3) Mock 后端（明确不可用，绝不伪造分数）
# ======================================================================
class MockJudgeBackend:
    """占位后端：available 恒为 False，complete 必抛。用于强制调用方走降级分支。"""

    name = "mock"

    @property
    def available(self) -> bool:
        return False

    def complete(
        self,
        messages: List[dict],
        *,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> JudgeCompletion:
        raise JudgeUnavailable("mock 后端不提供推理；请配置 JUDGE_BACKEND=http 或 local")


# ======================================================================
# 4) 选择与单例
# ======================================================================
def build_backend(kind: Optional[str] = None) -> JudgeBackend:
    """按配置构造后端。kind 为 None 时读 settings.judge_backend。"""
    kind = (kind or settings.judge_backend or "mock").lower()
    if kind == "http":
        return HttpJudgeBackend(
            base_url=settings.judge_base_url,
            model=settings.judge_model,
            api_key=settings.judge_api_key,
            timeout=settings.judge_timeout,
        )
    if kind == "local":
        return LocalJudgeBackend(settings.model_path, settings.device)
    return MockJudgeBackend()


_backend: Optional[JudgeBackend] = None


def get_backend() -> JudgeBackend:
    """进程内单例（本地后端的权重加载代价高，必须复用）。"""
    global _backend
    if _backend is None:
        _backend = build_backend()
    return _backend


def reset_backend() -> None:
    """清空单例（供测试切换配置）。"""
    global _backend
    _backend = None
