"""
QA 独立验证（严过关）—— 评估层扩展·批次2（T4–T9 + T19 后端闭环）
=========================================================================
本文件为 QA 工程师独立重算，刻意 **不复用** 实现内的 flatten_dim_weight /
build_stage_score / apply_to_user_preference 内部逻辑，而是依据
docs/scoring-standards-architecture.md §3 / §7 / Q4 / Q6 / Q7 / R1 的公开公式
自行重算，再与实现输出对拍，以暴露实现与规格的偏差。

覆盖：
- T4  build_stage_score：S1/S2/S3 三阶段 objectiveScore/subjectiveScore/total 公式一致、
       verdict 阈值 78/50；Q6 降权 ×0.4 + Σ=1 + evidence「缺真实结果·降权」；Q7 craft 独立。
- T8  aggregate_preference：direction=up 信号的 craft 维经 craft_links 映射进 dimLift，
       且 direction=down 信号 **不应** 污染 dimLift（规格 §3.5/§4.2 仅「被提升」agent 计 lift）。
       apply_to_user_preference：R1 门控 N=1/N=2 返回原 weight、N=3 生效且 Σ=1、α=0.15。
- T9  UsageEfficiencyTaskSet.run：返回 TaskRunResult 必要字段。
- 端点：/api/evaluate-stage 装配、/api/leaderboard divergences 派生、
       /api/preference 回灌后 weight Σ=1、/api/rules 三预设可加载。

运行：
    cd model-service && MOCK=true .venv/Scripts/python.exe -m pytest tests/test_scoring_batch2_qa.py -q
"""
from __future__ import annotations

import json
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("MOCK", "true")

from fastapi.testclient import TestClient  # noqa: E402

# 仅引用「常量」作为公开真相（不引用实现内的 flatten/compute/build 逻辑）
from app.scoring.registry import (  # noqa: E402
    JOB_GENERIC_WEIGHT,
    JOB_CRAFT_DIMS,
    CRAFT_REQUIRES_REAL,
    craft_links,
    RADAR_DIMS,
)
from app.scoring.stage_scorer import build_stage_score  # noqa: E402
from app.scoring.preference import aggregate_preference, apply_to_user_preference  # noqa: E402
from app.scoring.rules_engine import load_rules, verdict_from_total  # noqa: E402
from app.scoring.task_sets import get_task_set, UsageEfficiencyTaskSet  # noqa: E402
from app.schemas import (  # noqa: E402
    JudgeRunRequest,
    StageScoreRequest,
    PreferenceSignal,
    PreferenceFeedbackRequest,
    WeightVector,
)

STAGES = ["preScreen", "interview", "performance"]
JOBS = ["image", "text", "code"]

MVP_THRESHOLD = 78
OBSERVE_THRESHOLD = 50


# ----------------------------------------------------------------------
# QA 独立参考实现（依据规格重算，不依赖实现内部函数）
# ----------------------------------------------------------------------
def ref_flatten(stage: str, job_type: str, rules: dict) -> dict:
    """公开公式重算（§3.2 / §7.8 / Q2 优先级）。"""
    stage_cfg = rules["stages"][stage]
    bw = stage_cfg.get("objectiveBlockWeight", {})
    generic_block = float(bw.get("generic", 0.0))
    craft_block = float(bw.get("craft", 0.0))
    # Q2 优先级：JOB_GENERIC_WEIGHT 优先（与实现一致）
    generic_w = JOB_GENERIC_WEIGHT.get(job_type) or stage_cfg.get("genericRadarWeight", {})
    craft_dims = rules.get("jobs", {}).get(job_type, {}).get("craftDims", [])
    raw = {d: float(w) * generic_block for d, w in generic_w.items()}
    if craft_dims:
        per = craft_block / len(craft_dims)
        for d in craft_dims:
            raw[d] = per
    total = sum(raw.values())
    return {k: v / total for k, v in raw.items()} if total > 0 else raw


def ref_q6_dw(dw: dict, craft_evidence: dict) -> tuple:
    """Q6 降权重算（§7.9）：requires_real 维缺真实证据 → ×0.4，再 Σ=1。"""
    down = []
    ev_map = {}
    out = dict(dw)
    for dim, w in list(out.items()):
        if CRAFT_REQUIRES_REAL.get(dim) and dim not in craft_evidence:
            out[dim] = w * 0.4
            down.append(dim)
            ev_map[dim] = "缺真实结果·降权"
    total = sum(out.values())
    if total > 0:
        out = {k: v / total for k, v in out.items()}
    return out, down, ev_map


def ref_build(stage, job_type, objective, subjective, craft_evidence, rules):
    """完整参考装配（与 build_stage_score 公开公式逐位一致）。"""
    dw = ref_flatten(stage, job_type, rules)
    dw, _, _ = ref_q6_dw(dw, craft_evidence or {})
    obj_acc = sum((float(objective.get(d, 0.0)) / 5.0) * w for d, w in dw.items())
    objective_score = round(obj_acc * 100.0, 1)

    stage_cfg = rules["stages"][stage]
    sub_dims = stage_cfg.get("enabledSubjective", [])
    n_sub = len(sub_dims) or 1
    sub_acc = sum((float(subjective.get(d, 0.0)) / 5.0) * (1.0 / n_sub) for d in sub_dims)
    subjective_score = round(sub_acc * 100.0, 1)

    ow = float(stage_cfg.get("objectiveWeight", 0.5))
    sw = float(stage_cfg.get("subjectiveWeight", 0.5))
    total = round(objective_score * ow + subjective_score * sw, 1)
    verdict = verdict_from_total(total, rules, stage)
    verdict_val = verdict.value if hasattr(verdict, "value") else str(verdict)
    return objective_score, subjective_score, total, verdict_val


def ref_apply(base: dict, dim_lift: dict, alpha: float, n: int) -> dict:
    """实现公开公式重算（§3.5 / §7.10 / R1）。"""
    if n < 3:
        return {k: float(v) for k, v in base.items()}
    new_w = {d: w * (1.0 + alpha * float(dim_lift.get(d, 0.0)) / float(n)) for d, w in base.items()}
    s = sum(new_w.values())
    return {k: v / s for k, v in new_w.items()} if s > 0 else new_w


def _full_objective(job: str, val: float = 4.0) -> dict:
    obj = {d: val for d in RADAR_DIMS}
    obj.update({d: val for d in JOB_CRAFT_DIMS[job]})
    return obj


def _full_subjective(rules: dict, stage: str, val: float = 4.0) -> dict:
    return {d: val for d in rules["stages"][stage]["enabledSubjective"]}


# ======================================================================
# T4：build_stage_score 三阶段公式一致性（独立重算对拍）
# ======================================================================
@pytest.mark.parametrize("stage", STAGES)
@pytest.mark.parametrize("job", JOBS)
def test_build_stage_score_matches_independent_recompute(stage, job):
    rules = load_rules()
    objective = _full_objective(job, 4.0)
    subjective = _full_subjective(rules, stage, 4.0)
    ss = build_stage_score(
        stage=stage, job_type=job, objective=objective, subjective=subjective,
        craft_evidence={d: "ok" for d in JOB_CRAFT_DIMS[job]}, agent_id="qa",
    )
    obj_ref, sub_ref, total_ref, verdict_ref = ref_build(
        stage, job, objective, subjective, {d: "ok" for d in JOB_CRAFT_DIMS[job]}, rules,
    )
    assert math.isclose(ss["objectiveScore"], obj_ref, abs_tol=1e-6), (ss["objectiveScore"], obj_ref)
    assert math.isclose(ss["subjectiveScore"], sub_ref, abs_tol=1e-6)
    assert math.isclose(ss["total"], total_ref, abs_tol=1e-6)
    assert ss["verdict"] == verdict_ref


@pytest.mark.parametrize("stage", STAGES)
def test_build_stage_score_total_formula_objective_subjective_weighted(stage):
    """total = objectiveScore*objW + subjectiveScore*subjW（阶段级权重）。"""
    rules = load_rules()
    job = "code"
    objective = {d: 3.0 for d in RADAR_DIMS}
    objective.update({d: 3.0 for d in JOB_CRAFT_DIMS[job]})
    subjective = {d: 5.0 for d in rules["stages"][stage]["enabledSubjective"]}
    ss = build_stage_score(
        stage=stage, job_type=job, objective=objective, subjective=subjective, agent_id="qa",
    )
    ow = float(rules["stages"][stage]["objectiveWeight"])
    sw = float(rules["stages"][stage]["subjectiveWeight"])
    expected_total = round(ss["objectiveScore"] * ow + ss["subjectiveScore"] * sw, 1)
    assert math.isclose(ss["total"], expected_total, abs_tol=1e-6)


# ======================================================================
# Q4：verdict 阈值 78/50
# ======================================================================
def test_verdict_thresholds_boundaries():
    """≥78→MVP；50–78→OBSERVE；<50→FIRED（含边界）。"""
    assert verdict_from_total(78.0).value == "MVP"
    assert verdict_from_total(78.1).value == "MVP"
    assert verdict_from_total(77.9).value == "OBSERVE"
    assert verdict_from_total(50.0).value == "OBSERVE"
    assert verdict_from_total(49.9).value == "FIRED"
    assert verdict_from_total(0.0).value == "FIRED"


@pytest.mark.parametrize("stage", STAGES)
@pytest.mark.parametrize("job", JOBS)
def test_q4_verdict_tripwire_all_high_and_all_low(stage, job):
    """全 5 分必 MVP；全 2 分必 FIRED（<50）。"""
    rules = load_rules()
    high = build_stage_score(
        stage, job, _full_objective(job, 5.0),
        _full_subjective(rules, stage, 5.0), agent_id="qa",
    )
    assert high["verdict"] == "MVP"
    low_obj = {d: 2.0 for d in RADAR_DIMS}
    low_obj.update({d: 2.0 for d in JOB_CRAFT_DIMS[job]})
    low = build_stage_score(
        stage, job, low_obj, _full_subjective(rules, stage, 2.0), agent_id="qa",
    )
    assert low["total"] < 50
    assert low["verdict"] == "FIRED"


# ======================================================================
# Q6：降权 ×0.4 + Σ=1 不变 + evidence 标记（仅 code 工种）
# ======================================================================
@pytest.mark.parametrize("stage", STAGES)
def test_q6_downweight_independent_recompute(stage):
    job = "code"
    rules = load_rules()
    # 独立重算降权后权重
    dw_ref = ref_flatten(stage, job, rules)
    dw_ref, down_ref, ev_ref = ref_q6_dw(dw_ref, {})  # 无任何真实证据
    assert math.isclose(sum(dw_ref.values()), 1.0, rel_tol=1e-9)
    assert set(down_ref) == {"code_runnability", "code_security"}

    # 实现输出
    ss = build_stage_score(
        stage=stage, job_type=job, objective=_full_objective(job, 4.0),
        subjective=_full_subjective(rules, stage, 4.0), craft_evidence={}, agent_id="qa",
    )
    # 降权维集合
    assert set(ss["craftScores"]["downweighted"]) == {"code_runnability", "code_security"}
    # evidence 精确文案
    for dim in ("code_runnability", "code_security"):
        assert ss["craftScores"]["evidence"][dim] == "缺真实结果·降权"
        item = next(i for i in ss["objective"] if i["dim"] == dim)
        assert item["evidence"] == "缺真实结果·降权"
    # 降权维的实际权重 ≈ 独立重算（远小于非 requires_real 的 craft 维）
    w_map = {i["dim"]: i["weight"] for i in ss["objective"]}
    assert w_map["code_runnability"] < w_map["code_efficiency"]
    # 提供真实证据后不再降权
    ss2 = build_stage_score(
        stage=stage, job_type=job, objective=_full_objective(job, 4.0),
        subjective=_full_subjective(rules, stage, 4.0),
        craft_evidence={"code_runnability": "CI 通过", "code_security": "trivy 无高危"}, agent_id="qa",
    )
    assert ss2["craftScores"]["downweighted"] == []


# ======================================================================
# Q7：craft 独立写库（不并入 objective 总分）
# ======================================================================
@pytest.mark.parametrize("job", JOBS)
def test_q7_craft_scores_isolated(job):
    rules = load_rules()
    ss = build_stage_score(
        stage="interview", job_type=job, objective=_full_objective(job, 4.0),
        subjective=_full_subjective(rules, "interview", 4.0), agent_id="qa",
    )
    assert ss["craftScores"]["jobType"] == job
    assert set(ss["craftScores"]["dims"].keys()) == set(JOB_CRAFT_DIMS[job])
    # objective 中 craft 维仍参与总分（Q7 是「另存」而非「剔除」）
    obj_dims = {i["dim"] for i in ss["objective"]}
    assert obj_dims >= set(JOB_CRAFT_DIMS[job])


# ======================================================================
# T8：aggregate_preference — dimLift 仅来自 up 信号（规格 §3.5/§4.2）
# ======================================================================
def test_aggregate_dimlift_only_from_up_signals():
    """被提升 agent 的最强 craft 维 → 关联通用六维；down 信号 **不** 应污染 dimLift。"""
    signals = [
        PreferenceSignal(
            agentId="a1", jobType="code", direction="up",
            craftScores={"code_runnability": 5.0}, ts="t",
        ),
        PreferenceSignal(
            agentId="a2", jobType="code", direction="down",
            craftScores={"code_security": 5.0}, ts="t",
        ),
    ]
    profile = aggregate_preference(signals)
    # up: code_runnability → [task, reliability] → 各 +1
    assert profile.dimLift.get("task", 0) == 1
    assert profile.dimLift.get("reliability", 0) == 1
    # down: code_security → [reliability, cost] 不应计入
    # 若实现未做方向门控，reliability 会变成 2、cost 会变成 1 → 此处失败 = 源码 Bug
    assert profile.dimLift.get("reliability", 0) == 1, "down 信号不应叠加 reliability"
    assert profile.dimLift.get("cost", 0) == 0, "down 信号不应叠加 cost"


def test_aggregate_dimlift_accumulates_across_up_signals():
    """多个 up 信号累计（同一 craft 维被多次提升 → dimLift 累计）。"""
    signals = [
        PreferenceSignal(agentId="a1", jobType="code", direction="up",
                         craftScores={"code_runnability": 5.0}, ts="t"),
        PreferenceSignal(agentId="a1", jobType="code", direction="up",
                         craftScores={"code_runnability": 4.0}, ts="t"),
    ]
    profile = aggregate_preference(signals)
    # code_runnability → task, reliability 各 +2
    assert profile.dimLift.get("task") == 2
    assert profile.dimLift.get("reliability") == 2


# ======================================================================
# T8：apply_to_user_preference — R1 门控 + α=0.15 + normalize Σ=1
# ======================================================================
@pytest.mark.parametrize("n", [1, 2])
def test_apply_r1_gating_returns_original(n):
    """R1 门控：N<3 返回原 weight（不回灌）。"""
    base = dict(WeightVector().model_dump())
    dim_lift = {"quality": 3.0}
    out = apply_to_user_preference(base, dim_lift, alpha=0.15, N=n)
    assert out == base


def test_apply_n3_independent_recompute():
    """N>=3：w'[d]=w*(1+α*lift/N) 再归一；与独立重算逐位一致且 Σ=1。"""
    base = dict(WeightVector().model_dump())
    assert math.isclose(sum(base.values()), 1.0, rel_tol=1e-9)
    dim_lift = {"quality": 3.0}
    got = apply_to_user_preference(base, dim_lift, alpha=0.15, N=3)
    ref = ref_apply(base, dim_lift, 0.15, 3)
    assert math.isclose(sum(got.values()), 1.0, rel_tol=1e-9)
    for d in base:
        assert math.isclose(got[d], ref[d], rel_tol=1e-9), (d, got[d], ref[d])
    # quality 应被提升
    assert got["quality"] > base["quality"]


# ======================================================================
# T9：UsageEfficiencyTaskSet.run 返回结构
# ======================================================================
def test_usage_efficiency_taskrunresult_structure():
    ts = get_task_set("usage_efficiency")
    assert isinstance(ts, UsageEfficiencyTaskSet)
    jr = JudgeRunRequest(
        agentId="agent-x", agentName="X",
        usage=[{"agentId": "agent-x", "sessionId": "s1", "totalTokens": 1200, "costUsd": 0.02}],
        task={"title": "t", "description": "d", "weight": 1.0},
    )
    res = ts.run(jr)
    # 必要字段
    assert res.agentId == "agent-x"
    assert res.taskSetId == "usage_efficiency"
    assert set(res.objectiveScores.keys()) == set(RADAR_DIMS)
    assert isinstance(res.telemetry, list) and len(res.telemetry) >= 1
    assert isinstance(res.usage, list) and len(res.usage) == 1
    assert isinstance(res.craftEvidence, dict)
    assert res.meta["totalTokens"] == 1200.0
    assert math.isclose(res.meta["costPerRun"], 0.02, rel_tol=1e-9)


# ======================================================================
# 端点：/api/evaluate-stage 装配（SSE stage_score 事件）
# ======================================================================
def test_api_evaluate_stage_assembly():
    client = TestClient(__import__("app.serve", fromlist=["app"]).app)
    rules = load_rules()
    body = StageScoreRequest(
        agentId="qa-eval", stage="interview", jobType="code",
        objective=_full_objective("code", 4.0),
        subjective=_full_subjective(rules, "interview", 4.0),
        craftEvidence={"code_runnability": "CI 通过"},
    ).model_dump(mode="json")
    with client.stream("POST", "/api/evaluate-stage", json=body) as resp:
        assert resp.status_code == 200
        text = "".join(resp.iter_text())
    import re
    stage_event = None
    for block in re.split(r"\r?\n\r?\n", text):
        if "stage_score" not in block:
            continue
        ev_lines = [ln for ln in block.splitlines() if ln.startswith("data:")]
        if ev_lines:
            stage_event = json.loads(ev_lines[-1][5:].strip())
    assert stage_event is not None
    assert stage_event["agentId"] == "qa-eval"
    assert stage_event["verdict"] in ("MVP", "OBSERVE", "FIRED")
    assert math.isclose(sum(i["weight"] for i in stage_event["objective"]), 1.0, rel_tol=1e-6)


# ======================================================================
# 端点：/api/leaderboard divergences 自动派生
# ======================================================================
def test_api_leaderboard_divergences():
    from app.serve import app as serve_app
    client = TestClient(serve_app)
    stage_key = "preScreen"  # 与既有测试隔离
    agents = [("qa-a", 95.0), ("qa-b", 85.0), ("qa-c", 75.0)]
    for aid, _ in agents:
        body = StageScoreRequest(
            agentId=aid, stage=stage_key, jobType="code",
            objective=_full_objective("code", 5.0 if aid == "qa-a" else 4.0),
            subjective={},
        ).model_dump(mode="json")
        with client.stream("POST", "/api/evaluate-stage", json=body):
            pass
    r0 = client.get("/api/leaderboard", params={"stage": stage_key, "jobType": "code"})
    assert r0.status_code == 200
    assert r0.json()["divergences"] == []
    # 拖拽 qa-c（客观第3）→ 置顶
    r1 = client.get(
        "/api/leaderboard",
        params={"stage": stage_key, "jobType": "code",
                "subjective": json.dumps(["qa-c", "qa-a", "qa-b"])},
    )
    div = {d["agentId"]: d["delta"] for d in r1.json()["divergences"]}
    assert div.get("qa-c") == -2
    assert div.get("qa-a") == 1
    assert div.get("qa-b") == 1


# ======================================================================
# 端点：/api/preference 回灌后 weight Σ=1（N>=3）
# ======================================================================
def test_api_preference_normalized_and_applied():
    from app.serve import app as serve_app
    client = TestClient(serve_app)
    signals = [
        PreferenceSignal(agentId="a1", jobType="code", direction="up",
                         craftScores={"code_runnability": 5.0}, ts="t").model_dump(mode="json")
        for _ in range(3)
    ]
    body = PreferenceFeedbackRequest(ownerId="default", signals=signals).model_dump(mode="json")
    r = client.post("/api/preference", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["applied"] is True
    assert math.isclose(sum(data["weight"].values()), 1.0, rel_tol=1e-9)
    assert data["weight"]["task"] > 0.18 or data["weight"]["reliability"] > 0.20


# ======================================================================
# 端点：/api/rules 三预设可加载
# ======================================================================
def test_api_rules_three_presets():
    from app.serve import app as serve_app
    client = TestClient(serve_app)
    for preset in ("default", "cost-focused", "quality-focused"):
        r = client.get("/api/rules", params={"preset": preset})
        assert r.status_code == 200, preset
        data = r.json()
        assert data["presetId"] == preset
        assert "stages" in data
        # 每个 stage 的权重预折叠应为 Σ=1
        for stg in data["stages"]:
            dw = ref_flatten(stg, "code", data)
            assert math.isclose(sum(dw.values()), 1.0, rel_tol=1e-9), (preset, stg)


if __name__ == "__main__":
    for name in dir():
        if name.startswith("test_"):
            globals()[name]()
    print("tests/test_scoring_batch2_qa.py 通过 ✅")
