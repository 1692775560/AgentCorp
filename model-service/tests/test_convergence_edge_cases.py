"""
收敛层边界条件验证。

覆盖主用例之外的极端输入与退化场景：
  1. K=1（仅 S₀ + 末轮）CR/R/St/CQ 行为合理不崩溃（含锚定 / 未锚定兜底）；
  2. 所有 belief embedding 完全相同 → 稳定度 St 应=1（方差为 0）、残差 R 正常；
  3. 锚点候选完全不在轨迹任何轮（非法 human_anchor_id）→ compute 不崩，CQ=0 兜底；
  4. Reversibility 多轮连续坍缩（turn1、turn2 均 1 候选）惩罚是否累加「正确」；
  5. pca2d 对「全相同点」返回全 [0,0]（确定性，且不抛错）；
  6. encode_summary 对超长文本 / 特殊字符不抛错且仍 L2 归一。

原则：所有期望值均在本文件内独立重算（不复用实现的数值助手），
仅导入被验证的函数本身，以「独立重算 vs 实现输出」的方式对拍。

运行（在 model-service 目录下，venv 已装 pydantic/pytest）：
    cd model-service && python -m pytest tests/ -q
"""
from __future__ import annotations

import math
import os
import sys

import pytest

# 让测试能 import app 包（命名空间包，无 __init__.py）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# MOCK=true 保证若触达 /api/evaluate-run 走 Mock（不触达模型 / 网络）
os.environ.setdefault("MOCK", "true")

# 仅 import 被验证的「生产函数」，不 import 其数值助手（助手本文件独立重算）
from app.scoring.encoder import (  # noqa: E402
    encode_summary,
    pca2d,
    DEFAULT_DIM,
)
from app.scoring.convergence import (  # noqa: E402
    CandidateEmbedding,
    TurnState,
    ConvergenceTrace,
    ConvergenceEngine,
)


# ======================================================================
# 独立数值助手（与生产实现平行，用于交叉核对，不引入实现内部函数）
# ======================================================================
def _l2(v):
    return math.sqrt(sum(x * x for x in v))


def _cos(a, b):
    na, nb = _l2(a), _l2(b)
    if na == 0 or nb == 0:
        return 0.0
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


def _std(vals):
    n = len(vals)
    if n == 0:
        return 0.0
    m = sum(vals) / n
    return math.sqrt(sum((v - m) ** 2 for v in vals) / n)


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


# ---- 构造助手（独立、与工程师实现平行）----
def _cand(cid, turn, text, job="code"):
    return CandidateEmbedding(
        candidateId=cid,
        turn=turn,
        summaryText=text,
        embedding=encode_summary(text),
        jobType=job,
    )


def _turn(turn, texts, belief_text):
    cands = [_cand(f"c-{turn}-{i}", turn, t) for i, t in enumerate(texts)]
    return TurnState(turn=turn, candidates=cands, beliefEmbedding=encode_summary(belief_text))


# ======================================================================
# 边界 1：K=1（仅 S₀ + 末轮）
# ======================================================================
def _make_trace_k1(anchor_in_final=True, anchor_present=True):
    """K=1：turn 0（S₀）+ turn 1（末轮）。"""
    s0 = _turn(0, ["opt a broad", "opt b broad", "opt c broad"], "initial broad understanding")
    s1 = _turn(1, ["opt a final", "opt b final"], "final understanding of need")
    anchor_id = None
    if anchor_present:
        anchor_id = (
            s1.candidates[0].candidate_id
            if anchor_in_final
            else s0.candidates[0].candidate_id
        )
    return ConvergenceTrace(
        runId="run-k1", agentId="a", jobType="code", k=1, turns=[s0, s1],
        anchorCandidateId=anchor_id, createdBy="o", ts="2026-01-01T00:00:00+00:00",
    )


def test_k1_anchored_no_crash_and_formula():
    """K=1 锚定：不崩溃，CR/R/St/CQ/score 与独立重算逐项一致。"""
    eng = ConvergenceEngine()
    trace = _make_trace_k1(anchor_in_final=True)
    score = eng.compute_convergence_score(trace)

    turns = sorted(trace.turns, key=lambda t: t.turn)
    n0, nK = len(turns[0].candidates), len(turns[-1].candidates)
    cr = 1 - nK / n0
    eK = list(turns[-1].belief_embedding)
    eA = list(turns[-1].candidates[0].embedding)
    r = _clamp(_l2([a - b for a, b in zip(eK, eA)]) / 2.0, 0, 1)
    aligns = [_cos(list(t.belief_embedding), eA) for t in turns]
    st = _clamp(1 - _std(aligns) / 1.0, 0, 1)
    cq = 1 if turns[-1].candidates[0].candidate_id in {c.candidate_id for c in turns[-1].candidates} else 0
    exp = 100 * (0.4 * cr + 0.4 * (1 - r) + 0.2 * st)

    assert score.convergence_quality == cq == 1
    # 实现将 contraction_rate/residual/stability 四舍五入到 6 位、score 到 4 位，
    # 故对拍用宽松绝对容差（非实现缺陷，仅舍入）。
    assert score.contraction_rate == pytest.approx(cr, abs=1e-4)
    assert score.residual == pytest.approx(r, abs=1e-4)
    assert score.stability == pytest.approx(st, abs=1e-4)
    assert score.convergence_score == pytest.approx(exp, abs=1e-3)
    assert 0.0 <= score.convergence_score <= 100.0


def test_k1_no_anchor_fallback_cq0():
    """K=1 未锚定：兜底 CQ=0、R=0、St=0，score 仅收缩率贡献。"""
    eng = ConvergenceEngine()
    trace = _make_trace_k1(anchor_present=False)
    score = eng.compute_convergence_score(trace)

    n0 = len(trace.turns[0].candidates)
    nK = len(trace.turns[-1].candidates)
    cr = 1 - nK / n0
    assert score.convergence_quality == 0
    # A3：未锚定 → anchored=False 标记「R/St 未参与评分」；
    # R/St 本身仍填 0.0 以保持数值契约（下游不必处理 null）。
    assert score.anchored is False
    assert score.residual == 0.0
    assert score.stability == 0.0
    # 未锚定路径归一化 bug 修复，用户 2026-08-08 拍定方案①：
    # 旧 100·w1·CR 不归一化，完美收缩仅因缺人类背书即被压到 40 分上限；
    # 新实现按收缩族独占分母 0.40 归一化 → 100·(0.40·CR)/0.40 = 100·CR。
    assert score.convergence_score == pytest.approx(100 * cr, abs=1e-3)


# ======================================================================
# 边界 2：所有 belief embedding 完全相同 → St=1
# ======================================================================
def test_all_beliefs_identical_stability_is_one():
    """所有轮 belief 相同 → 对齐序列方差=0 → 稳定度 St=1；残差 R 仍正常计算。"""
    eng = ConvergenceEngine()
    const = "constant belief across all turns"
    s0 = _turn(0, ["s0 a", "s0 b"], const)
    s1 = _turn(1, ["s1 a", "s1 b"], const)
    s2 = _turn(2, ["s2 a", "s2 b"], const)
    trace = ConvergenceTrace(
        runId="r-all-same", agentId="a", jobType="code", k=2,
        turns=[s0, s1, s2], anchorCandidateId="c-2-0", createdBy="o",
        ts="2026-01-01T00:00:00+00:00",
    )
    score = eng.compute_convergence_score(trace)

    # 独立重算：aligns 全为 cos(const_emb, anchor_emb) → 常数 → std=0 → St=1
    assert score.convergence_quality == 1
    assert score.stability == pytest.approx(1.0)
    assert 0.0 <= score.residual <= 1.0


# ======================================================================
# 边界 3：锚点候选完全不在轨迹任何轮（非法 anchor_candidate_id）
# ======================================================================
def test_illegal_anchor_id_not_in_trace_cq0():
    """anchor_candidate_id 指向轨迹中不存在的候选 → 不崩溃，走兜底 CQ=0。"""
    eng = ConvergenceEngine()
    trace = _make_trace_k1(anchor_in_final=True)
    trace.anchor_candidate_id = "ghost-candidate-absent-everywhere"
    score = eng.compute_convergence_score(trace)

    n0 = len(trace.turns[0].candidates)
    nK = len(trace.turns[-1].candidates)
    cr = 1 - nK / n0
    assert score.convergence_quality == 0          # 兜底
    # A3：锚点不可定位 → 与未锚定同路径，anchored=False
    assert score.anchored is False
    assert score.residual == 0.0
    assert score.stability == 0.0
    # 未锚定路径归一化 bug 修复，用户 2026-08-08 拍定方案①：
    # 锚点不可定位 → 与未锚定同路径，同样按收缩族分母 0.40 归一化 → 100·CR。
    assert score.convergence_score == pytest.approx(100 * cr, abs=1e-3)


# ======================================================================
# 边界 4：Reversibility 多轮连续坍缩（turn1、turn2 均 1 候选）惩罚是否累加正确
# ======================================================================
def test_reversibility_multi_collapse_single_penalty():
    """
    多轮连续坍缩（turn1、turn2 均 1 候选）的惩罚验证。

     构件 2：「对'在末轮前就坍缩到 1 个候选'施加惩罚」——表述为单数「施加惩罚」。
    实现与前端均用 `break` 只施加**一次** COLLAPSE_PENALTY(=0.5)（无论坍缩 1 轮还是多轮），
    即惩罚为「flat-once」而非按坍缩次数累乘。本测试锁定该行为：
      - 无坍缩 rev=1.0
      - 单/多坍缩 rev = mean(per_turn) × 0.5（相同乘数，不因多次坍缩而变 ×0.25）
    """
    eng = ConvergenceEngine()

    def build(collapse_turns):
        n = 4  # turn 0..3，K=3
        counts = [3, 3, 3, 3]
        for t in collapse_turns:
            counts[t] = 1
        turns = [
            _turn(t, [f"text turn {t} cand {i}" for i in range(counts[t])], f"belief {t}")
            for t in range(n)
        ]
        return ConvergenceTrace(
            runId="r", agentId="a", jobType="code", k=3, turns=turns,
            createdBy="o", ts="2026-01-01T00:00:00+00:00",
        )

    def exp_rev(collapse_turns):
        counts = [3, 3, 3, 3]
        for t in collapse_turns:
            counts[t] = 1
        per = [_clamp(c / 3.0, 0.0, 1.0) for c in counts]
        rev = sum(per) / len(per)
        # 任何「末轮之前」（idx < len-1=3）的坍缩 → 施加一次惩罚
        if any(t < 3 for t in collapse_turns):
            rev *= 0.5
        return rev

    base = eng.compute_convergence_score(build([])).reversibility
    single = eng.compute_convergence_score(build([1])).reversibility
    double = eng.compute_convergence_score(build([1, 2])).reversibility

    assert base == pytest.approx(1.0, abs=1e-6)
    assert single == pytest.approx(exp_rev([1]), abs=1e-5)
    assert double == pytest.approx(exp_rev([1, 2]), abs=1e-5)
    # 多轮坍缩仍是「一次性 ×0.5」(=0.3333…)，而非累乘 ×0.25(=0.1667…)
    assert double == pytest.approx(0.333333, abs=1e-4)
    assert double != pytest.approx(0.166667, abs=1e-4)
    assert double < single < base


# ======================================================================
# 边界 5：pca2d 对「全相同点」返回全 [0,0]（确定性、不抛错）
# ======================================================================
def test_pca2d_all_identical_points_returns_zeros():
    vecs = [[1.0, 2.0], [1.0, 2.0], [1.0, 2.0]]
    out = pca2d(vecs)
    assert out == [[0.0, 0.0], [0.0, 0.0], [0.0, 0.0]]
    # 确定性：同输入逐位一致
    assert pca2d(vecs) == out

    # 高维（d=64）全相同点同样返回全 [0,0]
    big = [[0.3] * DEFAULT_DIM, [0.3] * DEFAULT_DIM, [0.3] * DEFAULT_DIM]
    ob = pca2d(big)
    assert len(ob) == 3
    assert all(p == [0.0, 0.0] for p in ob)


# ======================================================================
# 边界 6：encode_summary 对超长文本 / 特殊字符不抛错且仍 L2 归一
# ======================================================================
def test_encode_summary_long_text_and_special_chars():
    # 超长文本（约 4 万字）
    long_text = "the quick brown fox " * 2000
    v = encode_summary(long_text)
    assert len(v) == DEFAULT_DIM
    assert abs(_l2(v) - 1.0) < 1e-9  # 非空 token 集合 → L2 归一为 1

    # 特殊字符 / emoji / 换行 / tab 混合（含中文）
    special = "用户需求🎉\t特殊\n字符！！！ hello world 测试"
    v2 = encode_summary(special)
    assert len(v2) == DEFAULT_DIM
    assert abs(_l2(v2) - 1.0) < 1e-9

    # 仅 emoji / 标点（无英数、无 CJK）→ 无匹配 token → 全 0 向量，仍不抛错
    emoji_only = "🎉🔥💡！！！???   "
    v3 = encode_summary(emoji_only)
    assert len(v3) == DEFAULT_DIM
    assert _l2(v3) == 0.0
