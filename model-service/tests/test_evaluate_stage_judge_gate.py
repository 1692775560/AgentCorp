"""P0 回归 —— /api/evaluate-stage 的 judge_available() 门禁
==================================================================
背景（2026-08-08 修复）：
`/api/evaluate-stage` 是**写榜单**端点——分数经 `_STAGE_STORE` 进入
`/api/leaderboard`，且 `scoring/stage_scorer.py` 会把非 craft 维标记为
`source="judge"`。修复前该端点缺少 `judge_available()` 门禁，judge 后端不可用时
仍照常出分，等于让一个从未经过模型评测的分数带着 "judge" 来源标签污染榜单，
下游没有任何字段能识别 —— 属静默污染，比给 0 分更糟。

修法采用 `/api/evaluate` 的**硬拒**风格（503），而非 `/api/judge` 的软降级：
写库路径宁可拒绝，也不让 confidence 打折的分数进 store 换个标签继续污染。

本文件锁定两条路径：
1. 非 mock + judge 不可用 → 503（不写 store）
2. mock 模式 → 正常放行（不破坏演示流）

运行（model-service 目录下）：
    python -m pytest tests/test_evaluate_stage_judge_gate.py -q
"""
from __future__ import annotations

import json
import os
import sys

import pytest

# 让测试能 import app 包（命名空间包，无 __init__.py）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 与既有测试一致：默认 MOCK=true，单测内再按需 monkeypatch 覆盖
os.environ.setdefault("MOCK", "true")

from fastapi.testclient import TestClient  # noqa: E402

from app.config import settings  # noqa: E402

# serve.py 在 import 时 makedirs(settings.upload_dir)（默认 /app/uploads，本机只读）；
# settings 可能已被先前测试模块实例化，直接覆写属性（与 test_http.py 同法）
import tempfile  # noqa: E402

settings.upload_dir = tempfile.mkdtemp(prefix="agentcorp-test-uploads-")

from app.routes import leaderboard as lb_routes  # noqa: E402
from app.serve import app  # noqa: E402


def _stage_body(agent_id: str = "agent-gate") -> dict:
    """构造最小可用的 StageScoreRequest 载荷（字段与 test_scoring_stage_and_preference 同构）。"""
    return {
        # 合法 stage 键取自 presets/default.json：preScreen / interview / performance。
        # 「S1 初审」是业务话术，不是配置键 —— 传 "S1" 会在
        # rules_engine.flatten_dim_weight 的 rules["stages"][stage] 抛 KeyError。
        "stage": "preScreen",
        "jobType": "code",
        "agentId": agent_id,
        "objective": {"code_correctness": 4.0, "code_maintainability": 3.5},
        "subjective": {"impression": 4.0},
        "scoredBy": "qa-gate",
    }


# ======================================================================
# 路径 1：非 mock + judge 不可用 → 503 硬拒
# ======================================================================
def test_evaluate_stage_returns_503_when_judge_unavailable(monkeypatch):
    """judge 后端不可用且非 mock → 503，且分数不得进入 _STAGE_STORE。"""
    monkeypatch.setattr(settings, "mock", False)
    monkeypatch.setattr(lb_routes, "judge_available", lambda: False)

    agent_id = "agent-gate-503"
    before = json.dumps(lb_routes._STAGE_STORE, sort_keys=True, default=str)

    client = TestClient(app)
    resp = client.post("/api/evaluate-stage", json=_stage_body(agent_id))

    assert resp.status_code == 503
    # 文案与 /api/evaluate 保持一致：提示 JUDGE_BACKEND / MOCK=true
    detail = resp.json().get("detail", "")
    assert "JUDGE_BACKEND" in detail
    assert "MOCK=true" in detail

    # 关键：硬拒必须发生在 build_stage_score 之前，store 不留脏数据
    after = json.dumps(lb_routes._STAGE_STORE, sort_keys=True, default=str)
    assert before == after
    # 注意：本断言原先写的是 .get("S1", {})，而 "S1" 从来不是合法 stage 键，
    # 该 get 恒返空 dict → 断言恒真（假绿）。改为 "preScreen" 后才真正生效。
    assert agent_id not in lb_routes._STAGE_STORE.get("preScreen", {}).get("code", {})


def test_evaluate_stage_gate_skipped_when_judge_available(monkeypatch):
    """非 mock 但 judge 可用 → 门禁放行（不误伤真实评测路径）。"""
    monkeypatch.setattr(settings, "mock", False)
    monkeypatch.setattr(lb_routes, "judge_available", lambda: True)

    client = TestClient(app)
    with client.stream("POST", "/api/evaluate-stage", json=_stage_body("agent-gate-ok")) as resp:
        assert resp.status_code == 200


# ======================================================================
# 路径 2：mock 模式放行（演示流不被破坏）
# ======================================================================
def test_evaluate_stage_allowed_in_mock_mode(monkeypatch):
    """mock=True 时即使 judge 不可用也放行，且 stage_score 事件正常产出。"""
    monkeypatch.setattr(settings, "mock", True)
    monkeypatch.setattr(lb_routes, "judge_available", lambda: False)

    agent_id = "agent-gate-mock"
    client = TestClient(app)

    events: list[str] = []
    payloads: list[str] = []
    with client.stream("POST", "/api/evaluate-stage", json=_stage_body(agent_id)) as resp:
        assert resp.status_code == 200
        for raw in resp.iter_lines():
            line = raw if isinstance(raw, str) else raw.decode("utf-8")
            if line.startswith("event:"):
                events.append(line.split(":", 1)[1].strip())
            elif line.startswith("data:"):
                payloads.append(line.split(":", 1)[1].strip())

    assert "stage_score" in events
    assert "done" in events

    # mock 放行后分数应正常落库（演示流完整）
    stored = lb_routes._STAGE_STORE.get("preScreen", {}).get("code", {})
    assert agent_id in stored

    parsed = [json.loads(p) for p in payloads if p.startswith("{")]
    assert any("objectiveScore" in obj for obj in parsed)
