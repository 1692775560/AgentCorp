"""
model-service/app/candidate_runner.py
候选 Agent「跑题」通道抽象（HR 面试 S2 的前置环节：把题面发给候选，拿回作答）。

评测的公平前提是「所有候选做同一道题」；本模块只负责「把题送出去、把答案收回来」，
评分在 craft_judge.py，两端通过 task.prompt 与 answer 字符串解耦。

通道（A2 / A3 双实现，均零新增依赖，HTTP 走标准库 urllib）：
  text    —— A3：直接使用调用方提供的答案文本（人工 / transcript 演示模式，最快闭环）
  gateway —— A2：经 OpenClaw gateway 的 OpenAI 兼容 /chat/completions 调度（真实跑题）
  未知通道 —— 抛 CandidateRunError，由调用方给出明确 4xx/5xx
"""
from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Dict, Optional, Protocol, runtime_checkable

from .config import settings

logger = logging.getLogger("candidate_runner")


class CandidateRunError(RuntimeError):
    """跑题失败（通道不可用 / 网络错误 / 上游异常 / 缺参）。"""


@dataclass
class CandidateAnswer:
    """一次跑题的产出（文本 + 通道 + 端到端耗时）。"""

    text: str
    channel: str
    latency_ms: float = 0.0


@runtime_checkable
class CandidateRunner(Protocol):
    """跑题通道契约：task_prompt → 候选答案文本。不理解评分语义。"""

    name: str

    @property
    def available(self) -> bool:
        ...

    def run(self, task_prompt: str, candidate: Dict) -> CandidateAnswer:
        ...


class TextCandidateRunner:
    """A3：直接使用调用方提供的答案文本（不走网络）。"""

    name = "text"

    @property
    def available(self) -> bool:
        return True

    def run(self, task_prompt: str, candidate: Dict) -> CandidateAnswer:
        answer = str(candidate.get("answer") or "").strip()
        if not answer:
            raise CandidateRunError("text 通道需要 candidate.answer 非空")
        return CandidateAnswer(text=answer, channel=self.name)


class GatewayCandidateRunner:
    """
    A2：经 OpenClaw gateway 的 OpenAI 兼容 /chat/completions 调度。

    base_url 缺省取 settings.gateway_base_url；候选引用可通过
    candidate.endpoint / candidate.model / candidate.apiKey 覆盖。
    响应结构与 judge_backend.HttpJudgeBackend 同口径（choices[0].message.content）。
    """

    name = "gateway"

    def __init__(self, base_url: str, model: str, timeout: float = 120.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    @property
    def available(self) -> bool:
        return bool(self.base_url and self.model)

    def run(self, task_prompt: str, candidate: Dict) -> CandidateAnswer:
        url = str(candidate.get("endpoint") or self.base_url).rstrip("/")
        model = str(candidate.get("model") or self.model)
        if not url or not model:
            raise CandidateRunError("gateway 通道需要 base_url 与 model（或 candidate.endpoint/model）")

        payload = {
            "model": model,
            "messages": [{"role": "user", "content": task_prompt}],
            "temperature": settings.temperature,
            "max_tokens": settings.judge_max_tokens,
            "stream": False,
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        api_key = str(candidate.get("apiKey") or settings.gateway_api_key or "")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        req = urllib.request.Request(
            f"{url}/chat/completions",
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
            raise CandidateRunError(f"gateway HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise CandidateRunError(f"gateway 不可达：{exc}") from exc

        elapsed_ms = (time.perf_counter() - started) * 1000.0
        try:
            data = json.loads(raw)
            text = data["choices"][0]["message"]["content"]
        except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
            raise CandidateRunError(f"gateway 响应结构异常：{exc}") from exc

        return CandidateAnswer(text=str(text), channel=self.name, latency_ms=elapsed_ms)


def build_runner(kind: Optional[str] = None) -> CandidateRunner:
    """按通道名构造 runner；kind 为 None 时读 settings.candidate_channel。"""
    kind = (kind or settings.candidate_channel or "text").lower()
    if kind == "gateway":
        return GatewayCandidateRunner(
            base_url=settings.gateway_base_url,
            model=settings.gateway_model,
            timeout=settings.candidate_timeout,
        )
    if kind == "text":
        return TextCandidateRunner()
    raise CandidateRunError(f"未知跑题通道：{kind}")


def run_candidate(task_prompt: str, candidate: Dict) -> CandidateAnswer:
    """按候选引用里的 channel（缺省 settings.candidate_channel）跑题。"""
    channel = str(candidate.get("channel") or settings.candidate_channel or "text").lower()
    runner = build_runner(channel)
    if not runner.available:
        raise CandidateRunError(f"跑题通道 {channel} 不可用（未配置或依赖缺失）")
    return runner.run(task_prompt, candidate)
