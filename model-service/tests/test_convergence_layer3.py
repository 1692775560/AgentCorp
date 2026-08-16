"""
model-service/tests/test_convergence_layer3.py
QA 独立验证 —— Layer3 收敛层（T13 数据模型 / T14 编码器+PCA / T15 收敛引擎 / T16 接口）。

运行（在 model-service 目录下，venv 已装 pydantic/fastapi/sse-starlette/pytest）：
    MOCK=true python -m pytest tests/test_convergence_layer3.py -q

设计原则：
- 纯单元 + 接口验证，不依赖真实模型 / NPU。
- 公式交叉核对：test 内**独立重算** CR/R/St/CQ/score（非抄实现），
  用于「前端公式对拍」前的后端自检。
- 确定性 + 复现：encode_summary 同输入同输出；pca2d 同输入逐位一致。
"""
from __future__ import annotations

import asyncio
import math
import os
import sys

import pytest

# 让测试能 import app 包（命名空间包，无 __init__.py）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# MOCK=true 保证 /api/evaluate-run 走 Mock（不触达模型 / 网络）
os.environ.setdefault("MOCK", "true")

from app.scoring.encoder import (  # noqa: E402
    encode_summary,
    pca2d,
    ConvergenceConfig,
    cosine_similarity,
    std_pop,
    clamp,
)
from app.scoring.convergence import (  # noqa: E402
    CandidateEmbedding,
    TurnState,
    ConvergenceTrace,
    HumanAnchor,
    ConvergenceScore,
    ConvergenceEngine,
    ConvSource,
)


# ======================================================================
# 工具：独立重算（与实现同公式，用于交叉核对）
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


def _make_candidate(cid, turn, text, job="code"):
    return CandidateEmbedding(
        candidateId=cid,
        turn=turn,
        summaryText=text,
        embedding=encode_summary(text),
        jobType=job,
    )


def _make_turn(turn, texts, belief_text):
    cands = [_make_candidate(f"c-{turn}-{i}", turn, t) for i, t in enumerate(texts)]
    return TurnState(turn=turn, candidates=cands, beliefEmbedding=encode_summary(belief_text))


def _make_trace(k=3, anchor_id=None):
    """构造一条 K=3 的收敛轨迹（turn 0..3），beliefs/候选各不相同。"""
    beliefs = [
        "initial broad understanding of the user need space",
        "refined understanding after first clarification turn one",
        "more focused understanding after second turn two",
        "final focused understanding of what user truly wants",
    ]
    cand_sets = [
        ["option alpha broad", "option beta broad", "option gamma broad", "option delta broad"],
        ["option alpha mid", "option beta mid", "option gamma mid"],
        ["option alpha narrow", "option beta narrow"],
        ["final option alpha", "final option beta"],
    ]
    turns = [_make_turn(t, cand_sets[t], beliefs[t]) for t in range(k + 1)]
    trace = ConvergenceTrace(
        runId="run-test-1",
        agentId="agent-x",
        jobType="code",
        k=k,
        turns=turns,
        anchorCandidateId=anchor_id,
        createdBy="owner-1",
        ts="2026-07-28T00:00:00+00:00",
    )
    return trace


# ======================================================================
# 编码器确定性 + 同义一致性
# ======================================================================
def test_encode_summary_deterministic_and_normalized():
    """同输入同输出；非空文本 L2 归一为 1；空文本返回全 0。"""
    a = encode_summary("The cat sat on the mat")
    b = encode_summary("The cat sat on the mat")
    assert a == b, "确定性投影必须可复现"
    assert abs(_l2(a) - 1.0) < 1e-9, "非空文本应 L2 归一化"
    c = encode_summary("completely different summary about clouds")
    assert a != c
    z = encode_summary("")
    assert z == [0.0] * len(z)


def test_encode_summary_synonym_consistency():
    """同义改写（相同 token 集合）→ 相同向量（编码器标定要求）。"""
    x = encode_summary("the model understands user intent well")
    y = encode_summary("User intent well the model understands")  # 词序打乱
    assert x == y, "token 集合一致应得相同向量"


def test_encode_summary_cjk_tokenize():
    """中文摘要可按字分词且不抛错，得到归一向量。"""
    v = encode_summary("用户想要一个简洁的登录页面")
    assert abs(_l2(v) - 1.0) < 1e-9


# ======================================================================
# PCA 纯 Python 复现 + 主成分正确
# ======================================================================
def test_pca2d_reproducible():
    """同输入逐位一致（幂迭代确定性）。"""
    vecs = [[float(i), float(i * 2 + 1)] for i in range(6)]
    r1 = pca2d(vecs)
    r2 = pca2d(vecs)
    assert r1 == r2


def test_pca2d_collinear_second_component_zero():
    """共线点（y=0）→ 第 2 主成分 ≈ 0（y 全为 0）。"""
    vecs = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]]
    out = pca2d(vecs)
    assert len(out) == 4
    for x, y in out:
        assert abs(y) < 1e-6, f"共线数据第 2 主成分应≈0，实际 y={y}"


def test_pca2d_edge_cases():
    assert pca2d([]) == []
    assert pca2d([[1.0, 2.0]]) == [[0.0, 0.0]]


def test_convergence_config_defaults():
    cfg = ConvergenceConfig()
    assert cfg.k == 3
    assert (cfg.w1, cfg.w2, cfg.w3) == (0.4, 0.4, 0.2)
    assert cfg.scale == 2.0
    assert cfg.weights_dict() == {"w1": 0.4, "w2": 0.4, "w3": 0.2}


# ======================================================================
# 数据模型字段（前后端契约）
# ======================================================================
def test_convergence_models_serialization_camel():
    """模型可构造；序列化（model_dump mode=json）与前端 snake_case 契约一致。

    注：与既有 schemas.py / evaluation.ts 一致，
    pydantic model_dump(mode="json") 默认输出 snake_case（by_alias=False），
    前端 TS 亦用 snake_case 字段名消费，故契约采用 snake_case。
    """
    cand = _make_candidate("c1", 0, "some summary text")
    dump = cand.model_dump(mode="json")
    assert "candidate_id" in dump and "summary_text" in dump
    turn = _make_turn(0, ["a", "b"], "belief text")
    td = turn.model_dump(mode="json")
    assert "belief_embedding" in td and "candidates" in td
    trace = _make_trace()
    trd = trace.model_dump(mode="json")
    assert "anchor_candidate_id" in trd and "created_by" in trd and "run_id" in trd
    # 反向：snake_case（兼容 camel 校验别名）输入可被解析
    t2 = ConvergenceTrace(**{
        "run_id": "r2", "agent_id": "a", "job_type": "code",
        "k": 3, "turns": [], "created_by": "o", "ts": "2026-01-01T00:00:00+00:00",
    })
    assert t2.run_id == "r2"


# ======================================================================
# compute_convergence_score 与公式一致
# ======================================================================
def test_convergence_score_full_anchored():
    """完整锚定（锚点≈末轮 belief，且候选在末轮集）→ 独立重算对拍。"""
    eng = ConvergenceEngine()
    final_belief = "final focused understanding of what user truly wants"
    trace = _make_trace()
    trace.turns[-1].candidates[0].summary_text = final_belief
    anchor_id = trace.turns[-1].candidates[0].candidate_id
    trace.anchor_candidate_id = anchor_id

    score = eng.compute_convergence_score(trace)

    turns = sorted(trace.turns, key=lambda t: t.turn)
    n0, nK = len(turns[0].candidates), len(turns[-1].candidates)
    cr = 1 - nK / n0
    eK = list(turns[-1].belief_embedding)
    eA = list(turns[-1].candidates[0].embedding)  # 同文本 == eK
    r = _clamp(_l2([a - b for a, b in zip(eK, eA)]) / 2.0, 0, 1)
    aligns = [_cos(list(t.belief_embedding), eA) for t in turns]
    st = _clamp(1 - _std(aligns) / 1.0, 0, 1)
    cq = 1 if anchor_id in {c.candidate_id for c in turns[-1].candidates} else 0
    exp = 100 * (0.4 * cr + 0.4 * (1 - r) + 0.2 * st)

    assert score.convergence_quality == cq == 1
    assert score.contraction_rate == pytest.approx(cr)
    assert score.residual == pytest.approx(r)
    assert score.stability == pytest.approx(st)
    assert score.convergence_score == pytest.approx(exp)
    assert 0 <= score.reversibility <= 1
    assert score.weights == {"w1": 0.4, "w2": 0.4, "w3": 0.2}


def test_convergence_score_no_anchor_fallback_cq0():
    """无锚点 → CQ=0 兜底，score 仅由收缩率贡献（100·w1·CR）。"""
    eng = ConvergenceEngine()
    trace = _make_trace(anchor_id=None)
    score = eng.compute_convergence_score(trace)
    assert score.convergence_quality == 0
    n0 = len(trace.turns[0].candidates)
    nK = len(trace.turns[-1].candidates)
    cr = 1 - nK / n0
    # 未锚定路径归一化 bug 修复，用户 2026-08-08 拍定方案①：
    # 旧实现 100·w1·CR 不归一化，CR=1.0 的完美收缩 trace 仅因缺人类背书即被压到 40 分上限。
    # 新实现按收缩族独占分母 0.40 归一化：100·(0.40·CR)/0.40 = 100·CR。
    assert score.convergence_score == pytest.approx(100 * cr)
    # A3：未锚定时由 anchored=False 标记「未参与评分」，
    # 不能只看 R/St 的 0.0 —— 那在数值上与「完美对齐」无法区分
    assert score.anchored is False
    assert score.residual == 0.0 and score.stability == 0.0


def test_convergence_score_anchor_not_in_final_set_cq0():
    """锚点已设但其候选不在末轮集 → CQ=0（仍可算 R/St）。"""
    eng = ConvergenceEngine()
    trace = _make_trace()
    anchor_id = trace.turns[0].candidates[0].candidate_id
    trace.anchor_candidate_id = anchor_id
    score = eng.compute_convergence_score(trace)
    assert score.convergence_quality == 0
    # 已锚定 → anchored=True，R/St 真实参与评分，只是 CQ 不给分
    assert score.anchored is True


def test_reversibility_collapse_penalty():
    """末轮前坍缩到 1 候选 → 可逆性施加惩罚（×0.5）。"""
    eng = ConvergenceEngine()

    def build(collapse_turn1: bool):
        beliefs = ["b0", "b1", "b2", "b3"]
        sets = [
            ["a", "b", "c"],
            ["a"] if collapse_turn1 else ["a", "b", "c"],
            ["a", "b", "c"],
            ["a", "b", "c"],
        ]
        turns = [
            TurnState(
                turn=t,
                candidates=[
                    _make_candidate(f"c-{t}-{i}", t, sets[t][i])
                    for i in range(len(sets[t]))
                ],
                beliefEmbedding=encode_summary(beliefs[t]),
            )
            for t in range(4)
        ]
        return ConvergenceTrace(
            runId="r", agentId="a", jobType="code", k=3, turns=turns,
            createdBy="o", ts="2026-01-01T00:00:00+00:00",
        )

    base = eng.compute_convergence_score(build(False)).reversibility
    pen = eng.compute_convergence_score(build(True)).reversibility
    assert base == pytest.approx(1.0)
    # 坍缩：turn1 只有 1 候选 → 该轮 per_turn=clamp(1/3)=0.333，
    # 均值=(1+0.333+1+1)/4=0.8333，再 ×0.5 惩罚
    expected_pen = (1.0 + 1.0 / 3.0 + 1.0 + 1.0) / 4.0 * 0.5
    assert pen < base
    assert pen == pytest.approx(expected_pen)


def test_k_configurable_and_custom_weights():
    """k 可配；自定义权重（w3=0）时 score = 100·(w1·CR + w2·(1−R))。"""
    cfg = ConvergenceConfig(k=5, w1=0.5, w2=0.5, w3=0.0)
    eng = ConvergenceEngine(config=cfg)
    beliefs = [f"belief turn {t}" for t in range(6)]
    sets = [["a", "b", "c", "d"], ["a", "b", "c"], ["a", "b"], ["a", "b"],
            ["a", "b"], ["a", "b"]]
    turns = [
        TurnState(
            turn=t,
            candidates=[
                _make_candidate(f"c-{t}-{i}", t, sets[t][i])
                for i in range(len(sets[t]))
            ],
            beliefEmbedding=encode_summary(beliefs[t]),
        )
        for t in range(6)
    ]
    final_text = beliefs[-1]
    turns[-1].candidates[0].summary_text = final_text
    anchor_id = turns[-1].candidates[0].candidate_id
    trace = ConvergenceTrace(
        runId="rk", agentId="a", jobType="code", k=5, turns=turns,
        anchorCandidateId=anchor_id, createdBy="o", ts="2026-01-01T00:00:00+00:00",
    )
    score = eng.compute_convergence_score(trace)
    assert score.weights == {"w1": 0.5, "w2": 0.5, "w3": 0.0}
    n0, nK = len(turns[0].candidates), len(turns[-1].candidates)
    cr = 1 - nK / n0
    eK = list(turns[-1].belief_embedding)
    eA = list(turns[-1].candidates[0].embedding)
    r = _clamp(_l2([a - b for a, b in zip(eK, eA)]) / 2.0, 0, 1)
    exp = 100 * (0.5 * cr + 0.5 * (1 - r))
    assert score.convergence_score == pytest.approx(exp)
    assert score.convergence_quality == 1


def test_set_anchor_creates_human_anchor():
    """set_anchor 在轨迹候选集中定位 embedding 并生成 HumanAnchor。"""
    eng = ConvergenceEngine()
    trace = _make_trace()
    cid = trace.turns[1].candidates[0].candidate_id
    anchor = eng.set_anchor(trace, cid, source="explicit_pin")
    assert isinstance(anchor, HumanAnchor)
    assert anchor.candidate_id == cid
    assert anchor.source == "explicit_pin"
    assert trace.anchor_candidate_id == cid
    # A1：anchor_id 现在可被 get_anchor 反查（此前存的是 candidate_id，恒返回 None）
    assert eng.get_anchor(anchor.anchor_id) is anchor
    with pytest.raises(ValueError):
        eng.set_anchor(trace, "nonexistent-cid")


# ======================================================================
# A2：数据来源标注（projected/measured + synthetic）
# ======================================================================
def test_turn_state_defaults_to_projected_synthetic():
    """未标注来源的轮次默认按合成投影处理 —— 默认值方向不能反。

    若默认成 measured/False，投影演示数据会静默混进对外榜单。
    """
    ts = _make_turn(0, ["a broad", "b broad"], "belief text")
    assert ts.source == "projected"
    assert ts.synthetic is True


def test_turn_state_accepts_measured_explicitly():
    """真实模型编码路径可显式声明 measured/False。"""
    ts = TurnState(
        turn=1,
        candidates=[_make_candidate("c-1-0", 1, "x")],
        beliefEmbedding=encode_summary("y"),
        source="measured",
        synthetic=False,
    )
    assert ts.source == "measured" and ts.synthetic is False


def test_score_inherits_synthetic_from_turns():
    """轨迹含任一合成轮 → 分数必须标 synthetic，不得当实测用。"""
    eng = ConvergenceEngine()
    score = eng.compute_convergence_score(_make_trace())
    assert score.synthetic is True
    assert score.source == "projected"


def test_score_is_measured_only_when_all_turns_measured():
    """全部轮次实测才允许 measured/False —— 一轮投影即污染整条轨迹。"""
    eng = ConvergenceEngine()
    trace = _make_trace()
    for t in trace.turns:
        t.source = "measured"
        t.synthetic = False
    score = eng.compute_convergence_score(trace)
    assert score.source == "measured"
    assert score.synthetic is False


# ======================================================================
# 接口（FastAPI TestClient）
# ======================================================================
def test_convergence_endpoints_via_testclient():
    from fastapi.testclient import TestClient
    from app import config, serve

    config.settings.mock = True  # 走 Mock，避免触达模型加载
    client = TestClient(serve.app)
    trace = _make_trace(anchor_id=None).model_dump(mode="json")
    r = client.post("/api/convergence/trace", json=trace)
    assert r.status_code == 200, r.text
    run_id = r.json()["run_id"]
    assert run_id == "run-test-1"
    r = client.post("/api/convergence/score", json={"run_id": run_id})
    assert r.status_code == 200, r.text
    sc = r.json()
    assert "contraction_rate" in sc and "convergence_score" in sc
    r = client.get("/api/convergence/anchor", params={"ownerId": "owner-1"})
    assert r.status_code == 200 and r.json() == []
    anchor = HumanAnchor(
        anchorId="anchor-manual-1", candidateId="c-3-0",
        embedding=encode_summary("final focused understanding of what user truly wants"),
        ownerId="owner-1", source="explicit_pin",
        ts="2026-01-01T00:00:00+00:00",
    ).model_dump(mode="json")
    r = client.post("/api/convergence/anchor", json=anchor)
    assert r.status_code == 200 and r.json()["ok"] is True
    # A1：候选 c-3-0 属于已登记的 run-test-1，因此必须走 set_anchor 回填，
    # 而不是仅把锚点塞进 _anchors。anchored_run_id 就是回填成功的凭据。
    assert r.json()["anchored_run_id"] == run_id
    r = client.get("/api/convergence/anchor", params={"ownerId": "owner-1"})
    assert r.status_code == 200 and len(r.json()) == 1
    # A1 回归：设锚点后重新评分，CQ 必须从 0 翻到 1、anchored 必须为 True。
    # 旧实现绕过 set_anchor，此处会恒为 0/False —— 即人类背书对评分毫无影响。
    r = client.post("/api/convergence/score", json={"run_id": run_id})
    assert r.status_code == 200, r.text
    sc2 = r.json()
    assert sc2["convergence_quality"] == 1
    assert sc2["anchored"] is True
    assert sc2["convergence_score"] > sc["convergence_score"]


def test_evaluate_run_emits_convergence_sse():
    """/api/evaluate-run 命中 convergence 字段 → 发 convergence_update/convergence_score 事件。"""
    from fastapi.testclient import TestClient
    from app import config, serve

    config.settings.mock = True  # 走 Mock，避免触达模型加载
    client = TestClient(serve.app)
    body = {
        "agentId": "agent-sse",
        "agentName": "SSE Agent",
        "task": {"title": "design", "description": "build a login page", "weight": 1},
        "transcript": "user: make a login page",
        "usage": [{"totalTokens": 100, "costUsd": 0.01}],
        "convergence": {"k": 3, "captureSummaries": True},
    }
    r = client.post("/api/evaluate-run", json=body)
    assert r.status_code == 200, r.text
    events = []
    for line in r.text.split("\n"):
        line = line.strip()
        if line.startswith("event:"):
            events.append(line.split(":", 1)[1].strip())
    assert "convergence_update" in events, f"缺少 convergence_update，事件={events}"
    assert "convergence_score" in events, f"缺少 convergence_score，事件={events}"
