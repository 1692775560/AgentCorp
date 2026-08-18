"""
评分基础层覆盖验证：维度注册表、规则引擎、用户契合度、提示词与输出解析。

运行方式（在 model-service 目录下）：
    MOCK=true python -m pytest tests/ -q

设计原则：
- 纯单元验证，不依赖真实模型或专用硬件。
- 期望值按公开公式独立推算，而非复制实现内部逻辑，
  以便交叉核对客观分 / 主观分 / 总分与判定边界。
- 主观修正严格按乘法 fit *= (1 + delta) 断言，不假设为加法。
"""
from __future__ import annotations

import math
import os
import sys

import pytest

# 让测试能 import app 包（命名空间包，无 __init__.py）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.scoring.registry import (  # noqa: E402
    JOB_CRAFT_DIMS,
    SUBJECTIVE_DIMS,
    CRAFT_REQUIRES_REAL,
    craft_links,
    RADAR_DIMS,
)
from app.scoring.rules_engine import (  # noqa: E402
    load_rules,
    flatten_dim_weight,
    compute_stage_score,
    verdict_from_total,
)
from app.evaluator import compute_user_fit, parse_output  # noqa: E402
from app.prompt_templates import build_stage_system_prompt  # noqa: E402
from app.schemas import RadarScore, UserPreference, Verdict  # noqa: E402


STAGES = ["preScreen", "interview", "performance"]
JOBS = ["image", "text", "code"]
PREFIX = {"image": "img_", "text": "txt_", "code": "code_"}


# ======================================================================
# 目标 1：registry
# ======================================================================
def test_registry_job_craft_dims_prefix_and_count():
    """三工种各 5 个 craft 维，且前缀正确（img_/txt_/code_）。"""
    for job in JOBS:
        dims = JOB_CRAFT_DIMS[job]
        assert len(dims) == 5, f"{job} 应有 5 个 craft 维，实际 {len(dims)}"
        pre = PREFIX[job]
        for d in dims:
            assert d.startswith(pre), f"{job} 的 craft 维 {d} 前缀应为 {pre}"


def test_registry_subjective_dims_complete():
    """三阶段各自主观维齐全（与  一致）。"""
    assert SUBJECTIVE_DIMS["preScreen"] == ["sub_potential", "sub_aesthetic_lean"]
    assert SUBJECTIVE_DIMS["interview"] == [
        "sub_task_feel",
        "sub_communication",
        "sub_surprise",
    ]
    assert SUBJECTIVE_DIMS["performance"] == [
        "sub_trust",
        "sub_rehire",
        "sub_aesthetic_lean",
    ]


def test_registry_craft_requires_real():
    """Q6 强制真实执行/扫描标记：code_runnability / code_security = True。"""
    assert CRAFT_REQUIRES_REAL.get("code_runnability") is True
    assert CRAFT_REQUIRES_REAL.get("code_security") is True


def test_craft_links_code_runnability_nonempty():
    """craft_links('code_runnability') 返回非空、且均为通用六维。"""
    links = craft_links("code_runnability")
    assert links, "craft_links('code_runnability') 应返回非空列表"
    for d in links:
        assert d in RADAR_DIMS, f"关联维 {d} 应为通用六维之一"


# ======================================================================
# 目标 2：rules_engine.flatten_dim_weight
# ======================================================================
@pytest.mark.parametrize("stage", STAGES)
@pytest.mark.parametrize("job", JOBS)
def test_flatten_dim_weight_sums_to_one_and_enabled_only(stage, job):
    """9 组合：dimWeight Σ=1，且仅含本阶段启用维（通用6维 ∪ 本工种craft5维）。"""
    rules = load_rules()
    dw = flatten_dim_weight(stage, job, rules)
    assert math.isclose(sum(dw.values()), 1.0, rel_tol=1e-9), (
        f"{stage}/{job} dimWeight 未归一（Σ={sum(dw.values())}）"
    )
    expected_keys = set(RADAR_DIMS) | set(JOB_CRAFT_DIMS[job])
    assert set(dw.keys()) == expected_keys, (
        f"{stage}/{job} dimWeight 键集与启用维不符：{set(dw.keys()) ^ expected_keys}"
    )


@pytest.mark.parametrize("stage", STAGES)
def test_generic_weight_differentiation_image_vs_code(stage):
    """image 与 code 的通用六维向量不同（Q2 差异化生效）。"""
    rules = load_rules()
    img = {d: flatten_dim_weight(stage, "image", rules)[d] for d in RADAR_DIMS}
    code = {d: flatten_dim_weight(stage, "code", rules)[d] for d in RADAR_DIMS}
    assert img != code, f"{stage}: image 与 code 通用权重未差异化"
    assert img["creativity"] > code["creativity"], (
        f"{stage}: image.creativity 应 > code.creativity"
    )
    assert code["reliability"] > img["reliability"], (
        f"{stage}: code.reliability 应 > img.reliability"
    )


# ======================================================================
# 目标 3：rules_engine.compute_stage_score + verdict 边界
# ======================================================================
def _hand_calc(stage, job, obj_val, sub_val, rules):
    """与实现同公式的手算：objectiveScore / subjectiveScore / total。"""
    dw = flatten_dim_weight(stage, job, rules)
    obj_acc = sum((obj_val / 5.0) * dw[d] for d in dw)
    objective_score = round(obj_acc * 100.0, 1)

    sub_dims = rules["stages"][stage]["enabledSubjective"]
    n = len(sub_dims) or 1
    sub_acc = sum((sub_val / 5.0) * (1.0 / n) for _ in sub_dims)
    subjective_score = round(sub_acc * 100.0, 1)

    sc = rules["stages"][stage]
    total = round(objective_score * sc["objectiveWeight"] + subjective_score * sc["subjectiveWeight"], 1)
    return objective_score, subjective_score, total


@pytest.mark.parametrize("stage", STAGES)
@pytest.mark.parametrize("job", JOBS)
def test_compute_stage_score_matches_handcalc(stage, job):
    """给定客观=4.0、主观=4.0、default 规则，与手算一致。"""
    rules = load_rules()
    obj = {d: 4.0 for d in RADAR_DIMS}
    obj.update({d: 4.0 for d in JOB_CRAFT_DIMS[job]})
    sub = {d: 4.0 for d in rules["stages"][stage]["enabledSubjective"]}

    res = compute_stage_score(obj, sub, rules, stage, job_type=job)

    h_obj, h_sub, h_total = _hand_calc(stage, job, 4.0, 4.0, rules)
    assert res["objectiveScore"] == pytest.approx(h_obj, rel=1e-6)
    assert res["subjectiveScore"] == pytest.approx(h_sub, rel=1e-6)
    assert res["total"] == pytest.approx(h_total, rel=1e-6)
    # 实现的 verdict 必须与 verdict_from_total(total) 一致
    assert res["verdict"] == verdict_from_total(h_total, rules, stage)


def test_verdict_boundaries():
    """verdict 边界：≥78 MVP / [50,78) OBSERVE / <50 FIRED（边界值对拍）。"""
    assert verdict_from_total(77.9) is Verdict.OBSERVE
    assert verdict_from_total(78.1) is Verdict.MVP
    assert verdict_from_total(49.9) is Verdict.FIRED
    assert verdict_from_total(50.1) is Verdict.OBSERVE
    # 边界极值（含端点）
    assert verdict_from_total(78.0) is Verdict.MVP
    assert verdict_from_total(50.0) is Verdict.OBSERVE
    assert verdict_from_total(0.0) is Verdict.FIRED


# ======================================================================
# 目标 4：evaluator.compute_user_fit 主观叠加（Q3）
# ======================================================================
def _base_fit(radar: RadarScore, subjective=None) -> float:
    """默认偏好（neutral / budget200）+ 预算内 + 无技术栈命中的确定性基线。"""
    pref = UserPreference()  # 默认权重 Σ=1、neutral 审美、budget_max=200
    fit, _ = compute_user_fit(
        radar,
        pref,
        declared_budget=100,
        declared_tags=[],
        inferred_aesthetic=None,
        subjective=subjective,
    )
    return fit


def test_user_fit_no_subjective_backward_compat():
    """不传 subjective 时与旧行为（不传/显式 None）完全一致。"""
    radar = RadarScore(task=4, quality=4, comm=4, creativity=4, reliability=4, cost=4)
    fit_implicit = _base_fit(radar)
    fit_explicit_none = _base_fit(radar, subjective=None)
    assert fit_implicit == fit_explicit_none

    # 与既有 test_evaluate 中「满分应得 100%」用例对齐（旧行为不传 subjective）
    radar_full = RadarScore(task=5, quality=5, comm=5, creativity=5, reliability=5, cost=5)
    pref = UserPreference()
    fit_full, _ = compute_user_fit(
        radar_full, pref, declared_budget=100, declared_tags=["React"], inferred_aesthetic="neutral"
    )
    assert fit_full == 100.0


def test_user_fit_subjective_all5_uplift_capped():
    """传 subjective 全 5 分：user_fit 提升，且严格按乘法 fit*=(1+0.08) 封顶 +8%。"""
    radar = RadarScore(task=4, quality=4, comm=4, creativity=4, reliability=4, cost=4)
    fit_old = _base_fit(radar)
    assert fit_old < 100.0, "基线需未封顶，方能观察提升"

    sub = {d: 5.0 for d in ["sub_potential", "sub_aesthetic_lean", "sub_task_feel"]}
    fit_new = _base_fit(radar, subjective=sub)

    assert fit_new > fit_old, "全 5 主观分应提升 user_fit"
    # 乘法语义：delta 封顶 ±0.08 → fit_new == fit_old * 1.08
    assert fit_new == pytest.approx(fit_old * 1.08, rel=1e-6)
    # 增幅 ≤ +8%
    assert (fit_new - fit_old) / fit_old <= 0.08 + 1e-9


def test_user_fit_subjective_all0_drop_capped():
    """传 subjective 全 0 分：user_fit 下降，且按乘法 fit*=(1-0.08) 封顶 -8%。"""
    radar = RadarScore(task=4, quality=4, comm=4, creativity=4, reliability=4, cost=4)
    fit_old = _base_fit(radar)

    sub = {d: 0.0 for d in ["sub_potential", "sub_aesthetic_lean", "sub_task_feel"]}
    fit_new = _base_fit(radar, subjective=sub)

    assert fit_new < fit_old, "全 0 主观分应下降 user_fit"
    assert fit_new == pytest.approx(fit_old * 0.92, rel=1e-6)
    assert (fit_old - fit_new) / fit_old <= 0.08 + 1e-9


# ======================================================================
# 目标 5：prompt_templates.build_stage_system_prompt
# ======================================================================
def test_build_stage_system_prompt_keywords():
    """prompt 含 craft 子对象要求 + 三条硬规则关键词（注水/跨模态自洽/可靠性）。"""
    prompt = build_stage_system_prompt("code", "preScreen")
    assert "craft" in prompt, "系统提示应包含 craft 子对象要求"
    assert "注水" in prompt, "应包含硬规则：声明-交付一致性（注水检测）"
    assert "跨模态自洽" in prompt, "应包含硬规则：跨模态自洽"
    assert "可靠性" in prompt, "应包含硬规则：可靠性"
    # 本工种 craft 维应出现在提示中
    assert "code_runnability" in prompt


# ======================================================================
# 目标 6：parse_output 缺 craft 降级
# ======================================================================
def test_parse_output_missing_craft_degrades():
    """构造缺 craft 的模型原始输出，确认降级为 {} 且 craft_missing=True、不抛异常。"""
    raw = (
        '{"radar":{"task":4,"quality":3,"comm":2,"creativity":5,'
        '"reliability":4,"cost":3},"verdict":"MVP","confidence":0.9,'
        '"evidence_trace":["a"],"narration":"x","audio_script":"y"}'
    )
    data = parse_output(raw)
    assert data["craft"] == {}, "缺 craft 应降级为空 dict"
    assert data["craft_missing"] is True, "缺 craft 应标记 craft_missing=True"
    assert data["verdict"] == Verdict.MVP


if __name__ == "__main__":
    for name in dir():
        if name.startswith("test_"):
            globals()[name]()
    print("tests/test_scoring_core.py 全部通过 ✅")
