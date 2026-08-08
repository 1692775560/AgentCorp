"""
QA 独立验证 —— 评估层扩展·批次2（T4–T9 + T19 后端闭环）
==================================================================
针对批次2 新增能力做独立覆盖验证：

- T4  build_stage_score：S1/S2/S3 同构、Q6 降权（Σ=1 不变 + evidence 标记）、Q4 verdict
- T8  aggregate_preference / apply_to_user_preference：dimLift 映射、α=0.15、normalize、N<3 返回原 weight（R1 门控）
- T9  UsageEfficiencyTaskSet.run 返回 TaskRunResult
- T5  /api/rules 三预设可用（default / cost-focused / quality-focused）
- T4  /api/evaluate-stage 装配（SSE 事件）
- T7  /api/leaderboard 生成 divergences
- T8  /api/preference 回灌后 weight Σ=1
- T9  /api/evaluate-run 增 taskSetId（task_run 事件）

运行（在 model-service 目录下，venv 已装 pydantic/fastapi/sse-starlette/pytest）：
    MOCK=true python -m pytest tests/test_scoring_batch2.py -q
    python -m pytest tests/ -q   # 全量回归（含批次1 + Layer3）
"""
from __future__ import annotations

import json
import math
import os
import sys

import pytest

# 让测试能 import app 包（命名空间包，无 __init__.py）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# MOCK=true 保证 /api/evaluate-run 走 Mock（不触达模型 / 网络）
os.environ.setdefault("MOCK", "true")

from fastapi.testclient import TestClient  # noqa: E402

from app.scoring.stage_scorer import build_stage_score  # noqa: E402
from app.scoring.preference import (  # noqa: E402
    aggregate_preference,
    apply_to_user_preference,
)
from app.scoring.task_sets import get_task_set, UsageEfficiencyTaskSet  # noqa: E402
from app.scoring.rules_engine import load_rules, flatten_dim_weight  # noqa: E402
from app.scoring.registry import JOB_CRAFT_DIMS, RADAR_DIMS, craft_links  # noqa: E402
from app.schemas import (  # noqa: E402
    JudgeRunRequest,
    StageScoreRequest,
    PreferenceSignal,
    PreferenceFeedbackRequest,
    WeightVector,
)
from app.serve import app  # noqa: E402

STAGES = ["preScreen", "interview", "performance"]
JOBS = ["image", "text", "code"]


def _full_objective(job: str, val: float = 4.0) -> dict:
    obj = {d: val for d in RADAR_DIMS}
    obj.update({d: val for d in JOB_CRAFT_DIMS[job]})
    return obj


def _full_subjective(stage: str, val: float = 4.0) -> dict:
    rules = load_rules()
    return {d: val for d in rules["stages"][stage]["enabledSubjective"]}


# ======================================================================
# T4：build_stage_score
# ======================================================================
@pytest.mark.parametrize("stage", STAGES)
@pytest.mark.parametrize("job", JOBS)
def test_build_stage_score_isomorphic(stage, job):
    """S1/S2/S3 三阶段同构：均能装配出合法 StageScore。"""
    ss = build_stage_score(
        stage=stage, job_type=job,
        objective=_full_objective(job), subjective=_full_subjective(stage),
        agent_id="a1",
    )
    assert ss["stage"] == stage
    assert ss["jobType"] == job
    assert ss["objectiveScore"] >= 0
    assert ss["subjectiveScore"] >= 0
    assert ss["total"] >= 0
    assert ss["verdict"] in ("MVP", "OBSERVE", "FIRED")
    # craft 独立写库（Q7）
    assert ss["craftScores"]["jobType"] == job
    assert set(ss["craftScores"]["dims"].keys()) == set(JOB_CRAFT_DIMS[job])


@pytest.mark.parametrize("stage", STAGES)
@pytest.mark.parametrize("job", JOBS)
def test_q6_downweight_keeps_sum_one_and_marks_evidence(stage, job):
    """Q6：code_runnability/code_security 缺真实证据 → 该维 ×0.4 且 ΣdimWeight=1，evidence 标记。"""
    # 仅对 code 工种有意义（requires_real 仅 code_*）
    if job != "code":
        pytest.skip("Q6 仅 code 工种的 code_runnability/code_security 触发")
    rules = load_rules()
    dw = dict(flatten_dim_weight(stage, job, rules))
    assert math.isclose(sum(dw.values()), 1.0, rel_tol=1e-9)

    ss = build_stage_score(
        stage=stage, job_type=job,
        objective=_full_objective(job), subjective=_full_subjective(stage),
        craft_evidence={},  # 无任何真实证据 → 触发降权
        agent_id="a1",
    )
    # downweighted 含有两个 requires_real 维
    assert "code_runnability" in ss["craftScores"]["downweighted"]
    assert "code_security" in ss["craftScores"]["downweighted"]
    # evidence 标记「缺真实结果·降权」
    for dim in ("code_runnability", "code_security"):
        assert ss["craftScores"]["evidence"][dim] == "缺真实结果·降权"
        # objective 中对应项带 evidence
        item = next(i for i in ss["objective"] if i["dim"] == dim)
        assert item["evidence"] == "缺真实结果·降权"

    # 提供真实证据后不再降权
    ss2 = build_stage_score(
        stage=stage, job_type=job,
        objective=_full_objective(job), subjective=_full_subjective(stage),
        craft_evidence={"code_runnability": "CI 通过", "code_security": "trivy 扫描无高危"},
        agent_id="a1",
    )
    assert ss2["craftScores"]["downweighted"] == []


def test_q4_verdict_thresholds():
    """Q4：总分越高 verdict 越优（阈值 78/50）。"""
    # 全 5 分 → 高分
    high = build_stage_score("interview", "code", _full_objective("code", 5.0), _full_subjective("interview", 5.0), agent_id="a")
    assert high["verdict"] == "MVP"
    # 全 2 分 → 低分（<50）
    low = build_stage_score("interview", "code", {d: 2.0 for d in RADAR_DIMS} | {d: 2.0 for d in JOB_CRAFT_DIMS["code"]},
                            _full_subjective("interview", 2.0), agent_id="a")
    assert low["total"] < 50
    assert low["verdict"] == "FIRED"


# ======================================================================
# T8：偏好回灌
# ======================================================================
def test_aggregate_preference_dimlift_mapping():
    """被提升 agent 的最强 craft 维 → 关联通用六维映射进 dimLift。"""
    signals = [
        PreferenceSignal(
            agentId="a1", jobType="code", direction="up",
            craftScores={"code_runnability": 4.5, "code_security": 2.0, "code_efficiency": 3.0},
            ts="2026-01-01T00:00:00Z",
        )
    ]
    profile = aggregate_preference(signals)
    # 最强 craft = code_runnability → 关联 task / reliability
    assert profile.dimLift.get("task", 0) >= 1
    assert profile.dimLift.get("reliability", 0) >= 1
    # N 为信号数，由端点计算（profile 本身不含 N 字段）


def test_apply_to_user_preference_alpha_and_normalize():
    """N>=3：w'[d]=w*(1+α*lift/N)，再归一 Σ=1；被提升维权重上升。"""
    base = dict(WeightVector().model_dump())
    assert math.isclose(sum(base.values()), 1.0, rel_tol=1e-9)
    dim_lift = {"quality": 3.0}
    new_w = apply_to_user_preference(base, dim_lift, alpha=0.15, N=3)
    assert math.isclose(sum(new_w.values()), 1.0, rel_tol=1e-9)
    # quality 原始 0.2（WeightVector 默认）→ 0.2*(1+0.15*3/3)=0.2*1.15
    expected = base["quality"] * 1.15
    assert math.isclose(new_w["quality"], expected / sum([base[k] * (1 + 0.15 * dim_lift.get(k, 0) / 3) for k in base]), rel_tol=1e-9)
    assert new_w["quality"] > base["quality"]


def test_apply_to_user_preference_r1_gating_N_lt_3():
    """R1 门控：N<3 返回原 weight（不回灌）。"""
    base = dict(WeightVector().model_dump())
    dim_lift = {"quality": 3.0}
    new_w = apply_to_user_preference(base, dim_lift, alpha=0.15, N=2)
    assert new_w == base  # 原样返回


# ======================================================================
# T9：UsageEfficiencyTaskSet.run
# ======================================================================
def test_usage_efficiency_task_set_run_returns_taskrunresult():
    """UsageEfficiencyTaskSet.run 返回 TaskRunResult，含客观六维。"""
    ts = get_task_set("usage_efficiency")
    assert isinstance(ts, UsageEfficiencyTaskSet)
    jr = JudgeRunRequest(
        agentId="agent-x", agentName="X",
        usage=[{"agentId": "agent-x", "sessionId": "s1", "totalTokens": 1000, "costUsd": 0.01}],
        task={"title": "t", "description": "d", "weight": 1.0},
    )
    res = ts.run(jr)
    assert set(res.objectiveScores.keys()) == set(RADAR_DIMS)
    assert res.taskSetId == "usage_efficiency"
    assert res.agentId == "agent-x"
    assert res.meta["totalTokens"] == 1000.0


# ======================================================================
# 端点：/api/rules 三预设
# ======================================================================
def test_api_rules_three_presets():
    """GET /api/rules 三预设均可加载且不抛错。"""
    client = TestClient(app)
    for preset in ("default", "cost-focused", "quality-focused"):
        r = client.get("/api/rules", params={"preset": preset})
        assert r.status_code == 200, f"{preset} 应可加载"
        data = r.json()
        assert data["presetId"] == preset
        assert "stages" in data


# ======================================================================
# 端点：/api/evaluate-stage 装配（SSE）
# ======================================================================
def test_api_evaluate_stage_sse():
    """POST /api/evaluate-stage 发出 stage_score 事件并装配 StageScore。"""
    client = TestClient(app)
    body = StageScoreRequest(
        agentId="agent-eval", stage="interview", jobType="code",
        objective=_full_objective("code"), subjective=_full_subjective("interview"),
        craftEvidence={"code_runnability": "CI 通过"},
    ).model_dump(mode="json")
    with client.stream("POST", "/api/evaluate-stage", json=body) as resp:
        assert resp.status_code == 200
        text = "".join(chunk for chunk in resp.iter_text())
    # 解析 SSE：按事件块拆分（兼容 \n\n 与 \r\n\r\n），定位 stage_score 事件
    stage_event = None
    for block in __import__("re").split(r"\r?\n\r?\n", text):
        if "stage_score" not in block:
            continue
        event_lines = [ln for ln in block.splitlines() if ln.startswith("data:")]
        if event_lines:
            stage_event = json.loads(event_lines[-1][5:].strip())
    assert stage_event is not None, "应含 stage_score 事件"
    assert stage_event["agentId"] == "agent-eval"
    assert stage_event["verdict"] in ("MVP", "OBSERVE", "FIRED")


# ======================================================================
# 端点：/api/leaderboard 生成 divergences
# ======================================================================
def test_api_leaderboard_divergences(reset_sse):
    """POST /api/evaluate-stage 多次后，GET /api/leaderboard 按拖拽序派生 divergences。"""
    client = TestClient(app)
    stage_key = "performance"  # 与 SSE 测试（interview/agent-eval）隔离，避免 _STAGE_STORE 串扰
    # 注入 3 个 agent 的 stage score
    agents = [("dl-a", 90.0), ("dl-b", 80.0), ("dl-c", 70.0)]
    for aid, obj in agents:
        body = StageScoreRequest(
            agentId=aid, stage=stage_key, jobType="code",
            objective=_full_objective("code", 5.0 if obj >= 90 else 4.0),
            subjective=_full_subjective("performance", 4.0),
        ).model_dump(mode="json")
        reset_sse()  # 每次 stream 都是新 event loop，须先清掉上一次遗留的 Event 单例
        with client.stream("POST", "/api/evaluate-stage", json=body):
            pass

    # 默认序（无 subjective 参数）：无 divergence
    r0 = client.get("/api/leaderboard", params={"stage": stage_key, "jobType": "code"})
    assert r0.status_code == 200
    lb0 = r0.json()
    assert len(lb0["objective"]) == 3
    assert lb0["divergences"] == []

    # 拖拽序：把 dl-c（客观第3）拖到最前 → divergence
    r1 = client.get(
        "/api/leaderboard",
        params={
            "stage": stage_key, "jobType": "code",
            "subjective": json.dumps(["dl-c", "dl-a", "dl-b"]),
        },
    )
    lb1 = r1.json()
    div = {d["agentId"]: d["delta"] for d in lb1["divergences"]}
    assert div.get("dl-c") == -2  # 客观3 → 拖拽1，提升
    assert div.get("dl-a") == 1
    assert div.get("dl-b") == 1


# ======================================================================
# 端点：/api/preference 回灌 Σ=1
# ======================================================================
def test_api_preference_feedback_applied_and_normalized():
    """POST /api/preference 累计 N>=3 → 回灌新 weight 且 Σ=1。"""
    client = TestClient(app)
    signals = [
        PreferenceSignal(
            agentId="a1", jobType="code", direction="up",
            craftScores={"code_runnability": 5.0}, ts="t",
        ).model_dump(mode="json")
        for _ in range(3)
    ]
    body = PreferenceFeedbackRequest(ownerId="default", signals=signals).model_dump(mode="json")
    r = client.post("/api/preference", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["applied"] is True
    assert math.isclose(sum(data["weight"].values()), 1.0, rel_tol=1e-9)
    # task / reliability 应被提升（code_runnability → task + reliability）
    assert data["weight"]["task"] > 0.18 or data["weight"]["reliability"] > 0.20


def test_api_preference_r1_pending_when_n_lt_3():
    """N<3 → pending=True，返回原 weight（Σ=1）。"""
    client = TestClient(app)
    signals = [
        PreferenceSignal(agentId="a1", jobType="code", direction="up",
                        craftScores={"code_runnability": 5.0}, ts="t").model_dump(mode="json")
    ]
    body = PreferenceFeedbackRequest(ownerId="default", signals=signals).model_dump(mode="json")
    r = client.post("/api/preference", json=body)
    data = r.json()
    assert data["pending"] is True
    assert data["applied"] is False
    assert math.isclose(sum(data["weight"].values()), 1.0, rel_tol=1e-9)


# ======================================================================
# T9：/api/evaluate-run 增 taskSetId（task_run 事件）
# ======================================================================
def test_api_evaluate_run_with_task_set_id():
    """POST /api/evaluate-run 带 taskSetId → 发出 task_run 事件且主裁判流不变。"""
    client = TestClient(app)
    body = {
        "agentId": "agent-ts", "agentName": "TS",
        "task": {"title": "t", "description": "d", "weight": 1.0},
        "usage": [{"agentId": "agent-ts", "sessionId": "s1", "totalTokens": 500, "costUsd": 0.005}],
        "taskSetId": "usage_efficiency",
    }
    with client.stream("POST", "/api/evaluate-run", json=body) as resp:
        text = "".join(chunk for chunk in resp.iter_text())
    assert "task_run" in text, "应含 task_run 事件"
    assert "radar_update" in text, "主裁判流不受影响"


# ======================================================================
# T19：双 Leaderboard 拖拽锚点回填契约（后端 Layer3 锚点端点接受新来源）
# ======================================================================
def test_api_convergence_anchor_accepts_dual_leaderboard_drag():
    """POST /api/convergence/anchor 接受 source='dual_leaderboard_drag'。

    T19 前端在每次拖拽置顶时调用 convergenceStore.setAnchor(topAgentId,
    'dual_leaderboard_drag')，最终落到该端点。后端 HumanAnchor.source 为
    ConvSource Literal，必须接受新枚举值，且返回 ok + anchor_id。
    """
    client = TestClient(app)
    anchor = {
        "anchor_id": "anchor-run-t19-c1",
        "candidate_id": "c1",
        "embedding": [0.1, 0.2, 0.3],
        "owner_id": "owner-t19",
        "source": "dual_leaderboard_drag",
        "ts": "2026-07-28T00:00:00Z",
    }
    resp = client.post("/api/convergence/anchor", json=anchor)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data.get("ok") is True
    assert data.get("anchor_id") == "anchor-run-t19-c1"

    # 取回校验来源被原样保留
    got = client.get("/api/convergence/anchor", params={"ownerId": "owner-t19"})
    assert any(
        a.get("source") == "dual_leaderboard_drag" and a.get("candidate_id") == "c1"
        for a in got.json()
    )


if __name__ == "__main__":
    for name in dir():
        if name.startswith("test_"):
            globals()[name]()
    print("tests/test_scoring_batch2.py 全部通过 ✅")
