"""semantic_contraction（SC）维度测试：四格组合 + 零分母 + 负 delta。

覆盖设计文档《semantic-contraction-2026-08-08.md》第 5 节四格算例、
第 3 节防刷分条款（零分母返 None 不给满分）与负值语义（delta 据实记录）。

红线：格 2（锚定 + 无 unknowns）必须与改动前旧代码输出逐位一致 —— 这是
「走法一：向后兼容优先」的核心承诺，改动前实测基线 63.4701。
"""
from __future__ import annotations

import pytest

from app.scoring.convergence import (
    CandidateEmbedding,
    ConvergenceEngine,
    ConvergenceTrace,
    TurnState,
    Unknown,
    _semantic_contraction,
)

# 改动前旧代码实测基线（锚定路径，同一组输入）：
#   cr=0.6 r=0.468188 st=0.909879 score=63.4701 weights={w1:0.4,w2:0.4,w3:0.2}
BASELINE_ANCHORED_SCORE = 63.4701


def _emb(seed: int, dim: int = 8) -> list[float]:
    """确定性 embedding，保证测试可复现（不依赖随机数）。"""
    return [((seed * 7 + i * 13) % 100) / 100.0 for i in range(dim)]


def _cand(cid: str, turn: int, seed: int) -> CandidateEmbedding:
    return CandidateEmbedding(
        candidate_id=cid, turn=turn, summary_text="s", embedding=_emb(seed)
    )


def _unknowns(count: int) -> list[Unknown]:
    return [Unknown(uid=f"u{i}", text=f"未知项 {i}") for i in range(count)]


def _turns(u0_count: int = 0, uk_count: int = 0) -> list[TurnState]:
    """5 候选 → 2 候选（CR=0.6），unknowns 数量可配。"""
    t0 = TurnState(
        turn=0,
        candidates=[_cand(f"c{i}", 0, i) for i in range(5)],
        belief_embedding=_emb(1),
        unknowns=_unknowns(u0_count),
    )
    t1 = TurnState(
        turn=1,
        candidates=[_cand(f"c{i}", 1, i) for i in range(2)],
        belief_embedding=_emb(2),
        unknowns=_unknowns(uk_count),
    )
    return [t0, t1]


def _trace(u0_count: int = 0, uk_count: int = 0) -> ConvergenceTrace:
    return ConvergenceTrace(
        run_id="r-sc",
        agent_id="a-sc",
        turns=_turns(u0_count, uk_count),
        created_by="tester",
        ts="2026-08-08T00:00:00Z",
    )


# ======================================================================
# 纯函数：SC = clamp(1 − |U_K|/|U_0|, 0, 1)
# ======================================================================
def test_sc_zero_denominator_returns_none_not_full_marks():
    """|U_0|==0 一律返回 None，**不给满分** —— 防「不填 unknowns 反拿满分」。"""
    sc, delta = _semantic_contraction(0, 0)
    assert sc is None, "零分母必须返 None，缺失不得冒充优秀"
    assert delta == 0


def test_sc_zero_denominator_with_new_unknowns():
    """U_0 为空但末轮新增未知 → 仍返 None，delta 据实为正。"""
    sc, delta = _semantic_contraction(0, 3)
    assert sc is None
    assert delta == 3


def test_sc_full_resolution():
    """全部未知项消解 → SC=1.0。"""
    sc, delta = _semantic_contraction(4, 0)
    assert sc == pytest.approx(1.0)
    assert delta == -4


def test_sc_partial_resolution():
    """5 → 1 → SC = 1 − 1/5 = 0.8。"""
    sc, delta = _semantic_contraction(5, 1)
    assert sc == pytest.approx(0.8)
    assert delta == -4


def test_sc_negative_delta_clamped_but_delta_truthful():
    """unknowns 增加：SC clamp 到 0（不传导负分），delta 据实记正数。

    未知项增加是真实信号（探索中发现新未知），不是错误，故 delta 不掩盖。
    """
    sc, delta = _semantic_contraction(2, 5)
    assert sc == pytest.approx(0.0), "clamp 下界到 0，避免负分传导"
    assert delta == 3, "delta 据实记录，允许为正（新增未知）"


# ======================================================================
# 第 5 节四格组合
# ======================================================================
def test_grid2_anchored_no_unknowns_bitwise_identical_to_legacy():
    """格 2：锚定 + 无 unknowns → 与旧代码逐位一致（最高红线）。

    SC 不可用时权重回落给同族 CR（得完整 w1=0.40），恰好等于旧公式，
    这是「旧 trace 分数一分不变」的数学保证。
    """
    eng = ConvergenceEngine()
    trace = _trace(0, 0)
    eng.set_anchor(trace, "c0")
    score = eng.compute_convergence_score(trace)

    assert score.convergence_score == BASELINE_ANCHORED_SCORE, (
        "格 2 必须与改动前逐位一致，否则违反向后兼容承诺"
    )
    assert score.semantic_scored is False
    assert score.semantic_contraction == 0.0, "未计算时填 0.0 保数值契约"
    assert score.unknowns_delta == 0


def test_grid1_anchored_with_unknowns():
    """格 1：锚定 + 有 unknowns → 四项全参与，分母 1.00。"""
    eng = ConvergenceEngine()
    trace = _trace(5, 1)
    eng.set_anchor(trace, "c0")
    score = eng.compute_convergence_score(trace)

    assert score.semantic_scored is True
    assert score.semantic_contraction == pytest.approx(0.8)
    assert score.unknowns_delta == -4
    assert score.anchored is True
    assert 0.0 <= score.convergence_score <= 100.0
    # SC=0.8 > CR=0.6，让出权重给更高的 SC → 分数高于格 2
    assert score.convergence_score > BASELINE_ANCHORED_SCORE


def test_grid3_unanchored_with_unknowns():
    """格 3：未锚定 + 有 unknowns → 剔除 w2/w3，分母 0.40。

    100·(0.15·0.60 + 0.25·0.80) / 0.40 = 72.5
    """
    eng = ConvergenceEngine()
    score = eng.compute_convergence_score(_trace(5, 1))

    assert score.anchored is False
    assert score.semantic_scored is True
    assert score.convergence_score == pytest.approx(72.5, abs=1e-3)


def test_grid4_unanchored_no_unknowns_normalized():
    """格 4：未锚定 + 无 unknowns → 仅剩 CR，归一化后 100·CR = 60.0。

    行为变更：旧代码不归一化（100·0.4·0.6 = 24.0），上限被硬压在 40 分。
    见 docs/api/contracts.md 公示。
    """
    eng = ConvergenceEngine()
    score = eng.compute_convergence_score(_trace(0, 0))

    assert score.anchored is False
    assert score.semantic_scored is False
    assert score.convergence_score == pytest.approx(60.0, abs=1e-3)


@pytest.mark.parametrize(
    "u0,uk,anchored",
    [(0, 0, True), (5, 1, True), (0, 0, False), (5, 1, False)],
)
def test_normalization_arithmetic_self_consistent(u0: int, uk: int, anchored: bool):
    """四格归一化算术自洽：有效权重和恒等于分母，故满分上限恒为 100。

    注意「满分 100」是权重层面的性质，**不能**用构造真实 trace 去验 ——
    `CR = 1 − |S_K|/|S_0|` 而 |S_K| ≥ 1 恒成立，CR 永远取不到 1.0，
    任何真实 trace 都达不到 100。这里改为用引擎实际输出的各项值
    回代公式，验证归一化分母算对了（这才是本次改动的风险点）。
    """
    eng = ConvergenceEngine()
    trace = _trace(u0, uk)
    if anchored:
        eng.set_anchor(trace, "c0")
    score = eng.compute_convergence_score(trace)

    w = score.weights
    terms: list[tuple[float, float]] = []
    if score.semantic_scored:
        terms.append((w["w1"] - 0.25, score.contraction_rate))
        terms.append((0.25, score.semantic_contraction))
    else:
        terms.append((w["w1"], score.contraction_rate))
    if score.anchored:
        terms.append((w["w2"], 1.0 - (score.residual or 0.0)))
        terms.append((w["w3"], score.stability or 0.0))

    denom = sum(weight for weight, _ in terms)
    expected = 100.0 * sum(weight * value for weight, value in terms) / denom
    # 引擎对出参做 4 位舍入，回代时须同样舍入才可比（否则 68.4701 vs 68.47006）
    assert score.convergence_score == pytest.approx(round(expected, 4), abs=1e-6)
    assert 0.0 <= score.convergence_score <= 100.0


def test_unknowns_defaults_to_empty_list():
    """默认值指向「无数据 / 最保守」：不填 unknowns → SC 判 None 而非满分。"""
    turn = TurnState(turn=0, candidates=[_cand("c0", 0, 1)], belief_embedding=_emb(1))
    assert turn.unknowns == []


def test_new_fields_present_in_serialized_output():
    """出参必须携带三个新字段（数值契约，下游 toFixed/Number 不崩）。"""
    eng = ConvergenceEngine()
    payload = eng.compute_convergence_score(_trace(4, 2)).model_dump(mode="json")

    assert payload["semantic_contraction"] == pytest.approx(0.5)
    assert payload["semantic_scored"] is True
    assert payload["unknowns_delta"] == -2
    assert isinstance(payload["semantic_contraction"], float)
    assert isinstance(payload["unknowns_delta"], int)
