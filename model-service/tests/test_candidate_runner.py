"""
model-service/tests/test_candidate_runner.py

跑题通道（A2/A3）单测：
1. text 通道 —— 直接回传 answer；空 answer 抛 CandidateRunError
2. gateway 通道 —— 未配置时 available=False；未知通道抛错
3. run_candidate 分发 —— candidate.channel 覆盖全局配置
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from app.candidate_runner import (  # noqa: E402
    CandidateRunError,
    GatewayCandidateRunner,
    TextCandidateRunner,
    build_runner,
    run_candidate,
)


def test_text_runner_returns_answer():
    runner = TextCandidateRunner()
    assert runner.available is True
    result = runner.run("题面", {"answer": " 我是答案 "})
    assert result.text == "我是答案"
    assert result.channel == "text"


def test_text_runner_rejects_empty_answer():
    runner = TextCandidateRunner()
    with pytest.raises(CandidateRunError):
        runner.run("题面", {"answer": "   "})
    with pytest.raises(CandidateRunError):
        runner.run("题面", {})


def test_gateway_runner_available_requires_config():
    runner = GatewayCandidateRunner(base_url="", model="")
    assert runner.available is False
    runner2 = GatewayCandidateRunner(base_url="http://127.0.0.1:8000", model="m")
    assert runner2.available is True


def test_unknown_channel_raises():
    with pytest.raises(CandidateRunError):
        build_runner("nope")


def test_run_candidate_dispatches_by_channel():
    # candidate.channel 显式 text，即使全局默认是 gateway 也走 text
    result = run_candidate("题面", {"channel": "text", "answer": "ok"})
    assert result.channel == "text"


def test_gateway_runner_available_with_settings(monkeypatch):
    # 未配置 GATEWAY_BASE_URL 时，gateway 通道应报「不可用」
    monkeypatch.setattr("app.config.settings.candidate_channel", "gateway")
    monkeypatch.setattr("app.config.settings.gateway_base_url", "")
    monkeypatch.setattr("app.config.settings.gateway_model", "")
    with pytest.raises(CandidateRunError):
        run_candidate("题面", {"channel": "gateway"})
