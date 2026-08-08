"""
model-service/tests/test_evaluate_run.py
运行期裁判契约验证（T07 / 评估设计 §1.3）。

验证 /api/evaluate-run 的 Mock 派生流（evaluate_run, mode="mock"）：
  - 产出与 /api/evaluate 同构的 SSE 事件序列：radar_update ×6 + verdict + done
  - 六维维度集合、字段名严格对齐前端 judgeClient.parseBlock 解析契约
    （radar_update: dim/score/confidence/evidence；
     verdict: verdict/user_fit/evidence_trace/confidence；done: evaluation_id）
  - verdict ∈ {MVP, OBSERVE, FIRED}；verdict 阈值（avg>=4→MVP, >=2.5→OBSERVE, else FIRED）
  - 完全离线（不触达模型 / 网络），可复现（同输入同输出）

运行（在 model-service 目录下）：
    MOCK=true python -m pytest tests/ -q
或默认 auto（无 NPU 亦走 Mock）：
    python -m pytest tests/test_evaluate_run.py -q
"""
from __future__ import annotations

import asyncio
import os
import sys

import pytest

# 让测试能 import app 包
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.evaluator import (  # noqa: E402
    RadarScore,
    Verdict,
    _derive_run_radar,
    _verdict_from_radar,
    evaluate_run,
)
from app.schemas import JudgeRunRequest, JudgeTask  # noqa: E402


# ----------------------------------------------------------------------
# 工具
# ----------------------------------------------------------------------
def _collect(req: JudgeRunRequest, mode: str = "mock") -> list:
    return [ev for ev in asyncio.run(_gen(req, mode))]


async def _gen(req: JudgeRunRequest, mode: str) -> list:
    out = []
    async for ev in evaluate_run(req, mode=mode):
        out.append(ev)
    return out


def _make_request(agent_id: str, usage_cost: float = 0.0) -> JudgeRunRequest:
    return JudgeRunRequest(
        agent_id=agent_id,
        agent_name=f"agent-{agent_id}",
        task=JudgeTask(title="Build dashboard", description="...", weight=1.0),
        transcript="user: build a chart\nagent: done",
        usage=[
            {
                "timestamp": "2025-01-01T00:00:00Z",
                "sessionId": "sess-1",
                "agentId": agent_id,
                "inputTokens": 1000,
                "outputTokens": 500,
                "totalTokens": 1500,
                "costUsd": usage_cost,
            }
        ],
    )


EXPECTED_DIMS = {"task", "quality", "comm", "creativity", "reliability", "cost"}


# ----------------------------------------------------------------------
# 1) SSE 事件序列 + 字段契约（跨端对齐 judgeClient.parseBlock）
# ----------------------------------------------------------------------
def test_evaluate_run_event_sequence_and_contract():
    req = _make_request("agent-eval-01", usage_cost=0.3)
    events = _collect(req, mode="mock")

    # 按类型计数：6 雷达 + 1 宣判 + 1 done + 讲解/语音（语音闭环）
    radar_events = [e for e in events if e["type"] == "radar_update"]
    verdict_events = [e for e in events if e["type"] == "verdict"]
    done_events = [e for e in events if e["type"] == "done"]
    narration_events = [e for e in events if e["type"] == "narration"]
    audio_events = [e for e in events if e["type"] == "audio"]

    assert len(radar_events) == 6, "radar_update 必须恰好 6 个"
    assert len(verdict_events) == 1, "verdict 必须恰好 1 个"
    assert len(done_events) == 1, "done 必须恰好 1 个"
    assert len(narration_events) >= 2, "至少 1 条讲解 delta + 1 条 is_final"
    assert len(audio_events) >= 2, "讲解句 + 宣判各至少 1 个 audio 块"
    assert narration_events[-1]["is_final"] is True

    # audio chunk 必须可 base64 解码（mock 为 UTF-8 文本）
    import base64 as _b64

    for a in audio_events:
        assert set(["chunk", "format", "sample_rate"]).issubset(a.keys())
        decoded = _b64.b64decode(a["chunk"]).decode("utf-8")
        assert decoded.strip(), "mock audio chunk 应为非空 UTF-8 文本"

    # 事件顺序：最后一个 audio（宣判）在 verdict 之后、done 之前
    types = [e["type"] for e in events]
    assert types.index("verdict") < len(types) - 1 - types[::-1].index("audio") < types.index("done")

    # 六维集合完整且唯一（无 off-by-one / 缺失维度）
    dims = {e["dim"] for e in radar_events}
    assert dims == EXPECTED_DIMS, f"维度集合不符：{dims}"

    # 字段名严格对齐前端解析契约
    for e in radar_events:
        assert set(["dim", "score", "confidence", "evidence"]).issubset(e.keys())
        assert isinstance(e["score"], (int, float)) and 0.0 <= e["score"] <= 5.0
        assert isinstance(e["confidence"], (int, float))

    v = verdict_events[0]
    assert set(["verdict", "user_fit", "evidence_trace", "confidence"]).issubset(v.keys())
    assert v["verdict"] in {"MVP", "OBSERVE", "FIRED"}
    assert 0.0 <= v["user_fit"] <= 100.0
    assert isinstance(v["evidence_trace"], list)

    d = done_events[0]
    assert "evaluation_id" in d and bool(d["evaluation_id"])


# ----------------------------------------------------------------------
# 2) 完全离线（不触达模型 / 网络）
# ----------------------------------------------------------------------
def test_evaluate_run_offline_no_model():
    # mode="mock" 强制走 _stream_mock_run，绝不调用 get_model()/infer()
    # 若触达模型会抛 RuntimeError（无 NPU）。此处应正常产出。
    req = _make_request("agent-offline", usage_cost=0.0)
    events = _collect(req, mode="mock")
    assert any(e["type"] == "done" for e in events)


# ----------------------------------------------------------------------
# 3) 可复现（同输入 → 同 radar 分数）
# ----------------------------------------------------------------------
def test_evaluate_run_deterministic():
    req = _make_request("agent-deterministic", usage_cost=0.42)
    a = _collect(req, mode="mock")
    b = _collect(req, mode="mock")
    scores_a = {e["dim"]: e["score"] for e in a if e["type"] == "radar_update"}
    scores_b = {e["dim"]: e["score"] for e in b if e["type"] == "radar_update"}
    assert scores_a == scores_b, "同输入应产生完全一致的雷达分数"


# ----------------------------------------------------------------------
# 4) 成本维度由真实 usage 折算（验证 _derive_run_radar 成本分支）
# ----------------------------------------------------------------------
def test_evaluate_run_cost_dim_reflects_usage():
    # usage cost == 0 → cost 维回退为中性基线 2.5（未知，而非「及格」）
    req_zero = _make_request("agent-cost-zero", usage_cost=0.0)
    scores_zero = {
        e["dim"]: e["score"] for e in _collect(req_zero, mode="mock") if e["type"] == "radar_update"
    }
    assert scores_zero["cost"] == 2.5, "无成本数据时 cost 维应为中性基线 2.5"

    # usage cost 远超预算基准(1.0 USD) → cost 维被裁剪到 0
    req_high = _make_request("agent-cost-high", usage_cost=2.0)
    scores_high = {
        e["dim"]: e["score"] for e in _collect(req_high, mode="mock") if e["type"] == "radar_update"
    }
    assert scores_high["cost"] == 0.0, "超预算成本应把 cost 维裁剪为 0"


# ----------------------------------------------------------------------
# 5) 直接校验 verdict 阈值逻辑（与前端 verdictToLifecycleState 的 verdict 取值一致）
# ----------------------------------------------------------------------
def test_verdict_thresholds():
    # avg >= 4.0 → MVP
    assert _verdict_from_radar(
        RadarScore(task=4, quality=4, comm=4, creativity=4, reliability=4, cost=4)
    ) == Verdict.MVP
    # 2.5 <= avg < 4.0 → OBSERVE
    assert _verdict_from_radar(
        RadarScore(task=3, quality=3, comm=3, creativity=3, reliability=3, cost=3)
    ) == Verdict.OBSERVE
    # avg < 2.5 → FIRED
    assert _verdict_from_radar(
        RadarScore(task=1, quality=1, comm=1, creativity=1, reliability=1, cost=1)
    ) == Verdict.FIRED


# ----------------------------------------------------------------------
# 6) 公平性护栏：派生雷达与 agent_id 完全无关（LLM-as-judge 契约：
#    分数只由真实运行数据（transcript + usage）决定；旧实现用 md5(agent_id)
#    造分，改个名字分数就变——已移除）
# ----------------------------------------------------------------------
def test_derive_run_radar_independent_of_agent_id():
    r1 = _derive_run_radar(_make_request("agent-A", usage_cost=0.5))
    r2 = _derive_run_radar(_make_request("agent-B", usage_cost=0.5))
    # 相同 transcript/usage、不同 agent_id → 六维必须完全一致
    for d in EXPECTED_DIMS:
        assert getattr(r1, d) == getattr(r2, d), (
            f"维度 {d} 不应随 agent_id 变化（改名不能换分）"
        )


if __name__ == "__main__":
    for name in dir():
        if name.startswith("test_"):
            globals()[name]()
    print("tests/test_evaluate_run.py 全部通过 ✅")
