"""
model-service/tests/test_evaluate.py
验证评估契约与 user_fit 计算（不依赖真实模型。

运行（在 model-service 目录下）：
    pip install pytest
    MOCK=true python -m pytest tests/ -q
或（在无 NPU 环境，默认 auto 也会走 Mock）：
    python -m pytest tests/ -q
"""
from __future__ import annotations

import asyncio
import os
import sys

import pytest

# 让测试能 import app 包
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.evaluator import compute_user_fit, evaluate, parse_output  # noqa: E402
from app.schemas import (  # noqa: E402
    CandidateProfile,
    EvaluationRequest,
    RadarScore,
    UserPreference,
    Verdict,
)


def _collect(req: EvaluationRequest, mode: str = "mock") -> list:
    return [ev for ev in asyncio.run(_gen(req, mode))]


async def _gen(req: EvaluationRequest, mode: str) -> list:
    out = []
    async for ev in evaluate(req, mode=mode):
        out.append(ev)
    return out


def test_compute_user_fit_perfect():
    radar = RadarScore(
        task=5, quality=5, comm=5, creativity=5, reliability=5, cost=5
    )
    pref = UserPreference()  # 默认权重 + 中立审美 + 预算 200
    fit, evidence = compute_user_fit(
        radar, pref, declared_budget=100, declared_tags=["React"], inferred_aesthetic="neutral"
    )
    assert fit == 100.0, f"满分应得 100%，实际 {fit}"
    assert any("技术栈" in e for e in evidence)


def test_budget_overrun_zeros_cost():
    radar = RadarScore(
        task=5, quality=5, comm=5, creativity=5, reliability=5, cost=5
    )
    pref = UserPreference(budget_max=50)
    fit, evidence = compute_user_fit(
        radar, pref, declared_budget=200, declared_tags=[], inferred_aesthetic="neutral"
    )
    # 超预算 → cost 权重清零 → 低于满分
    assert fit < 100.0
    assert any("预算" in e for e in evidence)


def test_aesthetic_mismatch_penalty():
    radar = RadarScore(
        task=5, quality=5, comm=5, creativity=5, reliability=5, cost=5
    )
    pref = UserPreference(aesthetic=UserPreference().aesthetic.__class__("minimal"))
    fit, evidence = compute_user_fit(
        radar, pref, declared_budget=100, declared_tags=[], inferred_aesthetic="rich"
    )
    assert any("不符" in e for e in evidence)
    assert fit < 100.0


def test_parse_output_json_block():
    raw = (
        "```json\n"
        '{"radar":{"task":4,"quality":3,"comm":2,"creativity":5,"reliability":4,'
        '"cost":3},"verdict":"MVP","confidence":0.9,'
        '"evidence_trace":["a","b"],"narration":"x","audio_script":"y"}\n```'
    )
    data = parse_output(raw)
    assert data["radar"].task == 4.0
    assert data["verdict"] == Verdict.MVP
    assert data["confidence"] == 0.9
    assert len(data["evidence_trace"]) == 2


def test_parse_output_plain_json_no_fence():
    """无 ```json 代码块包裹的裸 JSON 也能解析（异常输入健壮性）"""
    raw = (
        '{"radar":{"task":3,"quality":4,"comm":2,"creativity":1,"reliability":5,'
        '"cost":2},"verdict":"OBSERVE","confidence":0.8,'
        '"evidence_trace":["x"],"narration":"n","audio_script":"a"}'
    )
    data = parse_output(raw)
    assert data["radar"].reliability == 5.0
    assert data["radar"].task == 3.0
    assert data["verdict"] == Verdict.OBSERVE
    assert data["confidence"] == 0.8


def test_parse_output_partial_radar_defaults():
    """radar 字段缺失时回落到 0.0（不崩）"""
    raw = '{"verdict":"FIRED","confidence":0.5}'
    data = parse_output(raw)
    assert data["radar"].task == 0.0
    assert data["radar"].cost == 0.0
    assert data["verdict"] == Verdict.FIRED


def test_parse_output_invalid_raises_value_error():
    """完全非 JSON / 空串输入应抛 ValueError（上层捕获，不静默崩溃）"""
    with pytest.raises(ValueError):
        parse_output("模型产出了一堆废话，没有任何 JSON 结构")
    with pytest.raises(ValueError):
        parse_output("")
    with pytest.raises(ValueError):
        parse_output("```json\n不是合法 json\n```")


def test_evaluate_stream_schema():
    cand = CandidateProfile(
        id="candidate-01",
        name="琳达",
        declared_budget=180,
        declared_tags=["React", "UI"],
    )
    pref = UserPreference()
    req = EvaluationRequest(candidate=cand, preference=pref)
    events = _collect(req, mode="mock")

    types = [e["type"] for e in events]
    assert "radar_update" in types
    assert "narration" in types
    assert "audio" in types
    assert "verdict" in types
    assert "done" in types

    # 六维逐维点亮
    radar_dims = [e["dim"] for e in events if e["type"] == "radar_update"]
    assert set(radar_dims) == {
        "task",
        "quality",
        "comm",
        "creativity",
        "reliability",
        "cost",
    }

    # verdict 字段校验
    verdict_ev = [e for e in events if e["type"] == "verdict"][0]
    assert verdict_ev["verdict"] == "MVP"
    assert 0 <= verdict_ev["user_fit"] <= 100
    assert isinstance(verdict_ev["evidence_trace"], list)

    # done 事件含 evaluation_id
    done_ev = [e for e in events if e["type"] == "done"][0]
    assert done_ev["evaluation_id"]


def test_evaluate_unknown_candidate_fallback():
    cand = CandidateProfile(id="upload-xyz", name="临时", declared_budget=120, declared_tags=[])
    pref = UserPreference()
    req = EvaluationRequest(candidate=cand, preference=pref)
    events = _collect(req, mode="mock")
    assert any(e["type"] == "verdict" for e in events)


if __name__ == "__main__":
    # 简易直接运行入口（python tests/test_evaluate.py）
    for name in dir():
        if name.startswith("test_"):
            globals()[name]()
    print("tests/test_evaluate.py 全部通过 ✅")
