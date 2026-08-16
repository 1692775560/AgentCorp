"""
model-service/app/scoring/convergence.py
收敛数据模型+ 收敛引擎。

- 数据模型（Pydantic）：CandidateEmbedding / TurnState / ConvergenceTrace /
  HumanAnchor / ConvergenceScore，字段与前端的 src/types/convergence.ts 严格镜像，
  且全部带 conv_ 命名空间意念（独立模型名，绝不占用 RADAR_DIMS /
  StageScore / DualLeaderboard / KpiRecord / RoiSnapshot 既有键。
- 引擎 ConvergenceEngine：record_turn / set_anchor / compute_convergence_score，
  严格按 公式（CR / R / St / CQ / convergence_score / Reversibility）。

零新增运行时依赖（仅 pydantic + 标准库）。前后端公式一致（R3 对拍）。
"""
from __future__ import annotations

import datetime
import math
import uuid
from typing import Dict, List, Literal, Optional

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    AliasGenerator,
)
from pydantic.alias_generators import to_camel

from .encoder import (
    ConvergenceConfig,
    clamp,
    cosine_similarity,
    std_pop,
)

# 锚点来源（MVP 先用 explicit_pin；批次 2 落地后回填 dual_leaderboard_drag）
ConvSource = Literal["explicit_pin", "dual_leaderboard_drag"]

# 序列化别名：输出 camelCase 以匹配前端；同时接受 snake/camel 输入。
_CONV_CONFIG = ConfigDict(
    populate_by_name=True,
    alias_generator=AliasGenerator(
        validation_alias=to_camel,
        serialization_alias=to_camel,
    ),
)


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# ======================================================================
# 1) 数据模型
# ======================================================================
class CandidateEmbedding(BaseModel):
    """单候选的潜在 embedding（每轮 agent 产出）。"""

    model_config = _CONV_CONFIG

    candidate_id: str
    turn: int  # 0 = S₀（初始），1..K
    summary_text: str  # "需求理解摘要" 原文
    embedding: List[float]  # 编码器输出（默认 d=64）
    job_type: str = "code"  # 复用既有 JobType 意念（image/text/code）


class Unknown(BaseModel):
    """单个待消解的未知项（semantic_contraction 维度输入）。

    uid 必填的理由：仅靠 text 判断「同一 unknown 是否已消解」只能做字符串
    匹配，措辞一变（「不清楚部署环境」→「部署环境待确认」）就会误判成
    「旧的消了、新的来了」——计数看似不变、实则完全错位。本期 SC 用纯计数差
    不依赖 uid，但 uid 缺失会让将来升级为「集合差」必须做数据迁移：
    现在留出来的成本是一个字段，将来补的成本是一次迁移。

    severity 同理为预留字段，本期不进权重，先占位避免将来加权时改结构。
    """

    model_config = _CONV_CONFIG

    uid: str  # 稳定 id（跨轮追踪同一未知项）
    text: str  # 人类可读描述
    severity: Literal["low", "mid", "high"] = "mid"  # 预留，本期不进权重


class TurnState(BaseModel):
    """单轮状态（候选集 + agent 的 belief embedding）。"""

    model_config = _CONV_CONFIG

    turn: int
    candidates: List[CandidateEmbedding]  # 该轮候选（建议 3–7，保可逆性）
    belief_embedding: List[float]  # agent "它以为你要什么" 的 embedding
    # 该轮尚未消解的未知项快照（非增量，存全量 → 首尾比在结构上可行）。
    # 默认空列表：默认值必须指向「无数据 / 最保守」而非「表现良好」——
    # 空 unknowns 会让 SC 判 None（权重回落给 CR），而不是白拿满分。
    unknowns: List[Unknown] = Field(default_factory=list)
    human_signal: Optional[ConvSource] = None  # 若该轮人类已置顶则记来源
    # A2：该轮数据来源。默认 projected/synthetic=True —— 未标注的数据不能
    # 默认当实测用，真实模型编码路径必须显式传 measured/False。
    source: Literal["projected", "measured"] = "projected"
    synthetic: bool = True


class ConvergenceTrace(BaseModel):
    """收敛轨迹（一次评估运行的完整记录）。"""

    model_config = _CONV_CONFIG

    run_id: str
    agent_id: str
    job_type: str = "code"
    stage: Optional[str] = None  # 可选关联到 S1/S2/S3
    k: int = 3  # 默认 3，可配置
    turns: List[TurnState]  # 含 turn=0 的 S₀
    # A1：改名自 human_anchor_id。引擎全程按 candidate_id 语义使用它
    # （在候选集里查 embedding），旧名会被误读成 HumanAnchor.anchor_id。
    anchor_candidate_id: Optional[str] = None
    created_by: str  # owner id
    ts: str


class HumanAnchor(BaseModel):
    """人类锚点（人即梯度源的落点）。"""

    model_config = _CONV_CONFIG

    anchor_id: str
    candidate_id: str  # 被背书的候选
    embedding: List[float]  # 锚点 embedding
    owner_id: str
    source: ConvSource  # explicit_pin（MVP）/ dual_leaderboard_drag（批次 2 后）
    ts: str


class ConvergenceScore(BaseModel):
    """收敛评分结果（对齐架构 §5.1 ConvergenceScore）。"""

    model_config = _CONV_CONFIG

    run_id: str
    agent_id: str
    contraction_rate: float  # CR ∈[0,1]
    residual: float  # R ∈[0,1]（越小越好）
    stability: float  # St ∈[0,1]
    # A3：R/St 是否真的参与了评分。
    # 未获人类背书时 R/St 仍填 0.0（保持数值契约，下游 toFixed / Number 不会崩），
    # 但 0 在语义上等同「完美对齐」，与「没算」无法区分 —— 必须靠本字段区分。
    # anchored=False 时 R/St 无意义，UI 应显示「—」而非 0.000。
    anchored: bool
    # SC ∈[0,1]：unknowns 缩减率。未计算时填 0.0 保数值契约（下游 toFixed /
    # Number 不崩），「没算」与「一项都没消解」靠 semantic_scored 区分 ——
    # 与上方 anchored 同一模式（A3 先例）。
    semantic_contraction: float
    # SC 是否真的参与了评分。false 时 semantic_contraction 无意义，
    # UI 应显示「—」而非 0.000。
    # 下游禁止靠 `is None` / `?? 0` 判断 —— 隐式契约会被某个 `or 0` 吃掉。
    semantic_scored: bool
    # |U_K| − |U_0|，据实记录，允许负数（负 = 未知项减少 = 收敛）。
    # 纯诊断字段，不进权重：unknowns 增加是真实信号（探索中发现新未知），
    # 不该被惩罚成「收敛失败」，故进 score 时另行 clamp 下界到 0。
    unknowns_delta: int
    convergence_score: float  # 0–100 = 100·(w1·CR + w2·(1−R) + w3·St)
    reversibility: float  # Rev ∈[0,1]（防越权）
    convergence_quality: int  # CQ（是否获人类背书，0|1）
    weights: Dict[str, float]  # {w1,w2,w3}
    ts: str
    # A2：由产出方显式标注，不由下游推断。
    # 'projected' = 确定性投影演示数据；'measured' = 真实模型编码。
    source: Literal["projected", "measured"]
    synthetic: bool  # true = 合成数据，不得进入任何对外榜单


# ======================================================================
# 2) 收敛引擎
# ======================================================================
# 末轮前坍缩到 1 候选的惩罚系数（可逆性
COLLAPSE_PENALTY = 0.5

# semantic_contraction 在「收缩族」内部占的权重。
#
# 权重分两族：收缩族 = {CR, SC}，对齐族 = {1−R, St}。
# w1 在本实现中语义为**收缩族总权重**（默认 0.40）：
#   - SC 可用时族内拆分：CR 得 w1 − W_SEM = 0.15，SC 得 W_SEM = 0.25
#   - SC 不可用时权重回落给 CR，CR 得完整 w1 = 0.40
#
# 「回落给同族的 CR」而非「摊给对齐族 w2/w3」是刻意选择：后者会让旧分数
# 立刻漂移，而历史分数可比性是本次最高约束（同一 agent 昨天 60 今天 45
# 且原因无法解释，是明确要避免的）。回落至 0.40 恰好等于旧代码的 w1，
# 这是旧 trace 分数逐位不变的数学保证。
#
# 也不选「CR 独吞 0.40 且 SC 另算」：那会让同一个 CR 值在有/无 unknowns
# 两种 trace 中的边际贡献差 2.67 倍，分数无法横向解释。
W_SEM = 0.25


def _semantic_contraction(
    u0_count: int, uk_count: int
) -> "tuple[Optional[float], int]":
    """SC = clamp(1 − |U_K| / |U_0|, 0, 1)，与 CR 的首尾比结构同构。

    Args:
        u0_count: turn 0 的 unknowns 数量 |U_0|。
        uk_count: 末轮 unknowns 数量 |U_K|。

    Returns:
        (sc, delta)。sc 为 None 表示「没算」（零分母）；
        delta = |U_K| − |U_0|，据实记录，允许负数。

    零分母（|U_0| == 0）一律返回 None，**不给满分**：否则形成刷分漏洞 ——
    不填 unknowns 反而拿满分，诚实填写反被扣分。这与「人气不得冒充能力」
    同源：缺失不得冒充优秀。
    """
    delta = uk_count - u0_count
    if u0_count <= 0:
        return None, delta
    sc = clamp(1.0 - uk_count / u0_count, 0.0, 1.0)
    return sc, delta


class ConvergenceEngine:
    """
    State-Space Convergence 三构件引擎（AgentCorp 原创空白）。

    - record_turn(trace, turn_state)：按 turn 号合并/追加一轮状态（S₀..K）。
    - set_anchor(trace, candidate_id, source)：在轨迹候选集中定位被背书候选，
      生成 HumanAnchor 并写入 trace.anchor_candidate_id。
    - compute_convergence_score(trace)：按 §3.5 公式产出 ConvergenceScore。
    """

    def __init__(self, config: Optional[ConvergenceConfig] = None) -> None:
        self.config = config or ConvergenceConfig()
        # 进程内锚点库：anchor_id -> HumanAnchor
        self._anchors: Dict[str, HumanAnchor] = {}

    # ---- 工具 ----
    def _sorted_turns(self, trace: ConvergenceTrace) -> List[TurnState]:
        return sorted(trace.turns, key=lambda t: t.turn)

    def _find_candidate_embedding(
        self, trace: ConvergenceTrace, candidate_id: str
    ) -> Optional[List[float]]:
        """在所有轮次的候选集中定位某 candidate_id 的 embedding。"""
        for turn in trace.turns:
            for c in turn.candidates:
                if c.candidate_id == candidate_id:
                    return list(c.embedding)
        return None

    # ---- 记录 / 锚点 ----
    def record_turn(
        self, trace: ConvergenceTrace, turn_state: TurnState
    ) -> ConvergenceTrace:
        """按 turn 号合并一轮状态（同号则替换，否则追加）。"""
        kept = [t for t in trace.turns if t.turn != turn_state.turn]
        kept.append(turn_state)
        trace.turns = kept
        return trace

    def set_anchor(
        self,
        trace: ConvergenceTrace,
        candidate_id: str,
        source: ConvSource = "explicit_pin",
    ) -> HumanAnchor:
        """
        在轨迹候选集中定位 candidate_id 的 embedding，生成 HumanAnchor。
        找不到该候选时抛 ValueError（明确失败，不静默）。
        """
        emb = self._find_candidate_embedding(trace, candidate_id)
        if emb is None:
            raise ValueError(
                f"set_anchor 失败：候选 {candidate_id} 不在轨迹任何轮的候选集中"
            )
        anchor = HumanAnchor(
            anchor_id=f"anchor-{trace.run_id}-{candidate_id}",
            candidate_id=candidate_id,
            embedding=emb,
            owner_id=trace.created_by,
            source=source,
            ts=_now_iso(),
        )
        self._anchors[anchor.anchor_id] = anchor
        trace.anchor_candidate_id = candidate_id
        return anchor

    def get_anchor(self, anchor_id: str) -> Optional[HumanAnchor]:
        return self._anchors.get(anchor_id)

    def list_anchors(self, owner_id: Optional[str] = None) -> List[HumanAnchor]:
        items = list(self._anchors.values())
        if owner_id is not None:
            items = [a for a in items if a.owner_id == owner_id]
        return items

    # ---- 核心评分 ----
    def compute_convergence_score(
        self, trace: ConvergenceTrace
    ) -> ConvergenceScore:
        """
        按 公式：

        CR  = 1 − |S_K| / |S_0|                       # 收缩率
        R   = clamp( ||e_K − e_anchor|| / scale , 0, 1)  # 残差
        St  = 1 − std( align(e_t, e_anchor) ) / 1.0    # 稳定度（max align=1）
        CQ  = 1 if (anchor_candidate ∈ candidate_set_K) else 0
        convergence_score = 100 · ( w1·CR + w2·(1−R) + w3·St )

        Reversibility = mean_t( clamp(n_candidates_t / 3, 0, 1) )；
        末轮前坍缩到 1 候选施加 COLLAPSE_PENALTY 惩罚。

        兜底（未锚定 / 锚点候选不在轨迹）：
          - 无锚点 → anchored=False，CQ=0，R、St 填 0.0 但不参与评分，
            score 仅由收缩率贡献（score = 100·w1·CR）。
            消费方必须先看 anchored 再读 R/St —— 否则会把「未背书」
            读成「零残差 / 零波动」，即误判为完美对齐。
        """
        cfg = self.config
        w = cfg.weights_dict()

        turns = self._sorted_turns(trace)
        if not turns:
            raise ValueError("compute_convergence_score 需要至少 1 个 turn")

        s0 = turns[0]
        sK = turns[-1]
        n0 = len(s0.candidates)
        nK = len(sK.candidates)
        # 收缩率
        cr = (1.0 - nK / n0) if n0 > 0 else 0.0

        # belief 序列
        beliefs = [list(t.belief_embedding) for t in turns]

        # 锚点定位
        anchor_id = trace.anchor_candidate_id
        anchored = False
        e_anchor: Optional[List[float]] = None
        if anchor_id is not None:
            e_anchor = self._find_candidate_embedding(trace, anchor_id)
            anchored = e_anchor is not None

        # semantic_contraction：首尾 unknowns 计数差（U_0 = turn 0，U_K = 末轮）
        sc_opt, unknowns_delta = _semantic_contraction(
            len(s0.unknowns), len(sK.unknowns)
        )

        r: float
        st: float
        if anchored and e_anchor is not None:
            eK = list(sK.belief_embedding)
            # 残差（模型已 L2 归一 → 最大距离 = scale=2.0）
            dist = l2_distance(eK, e_anchor)
            r = clamp(dist / cfg.scale, 0.0, 1.0)
            # 稳定度：align = cosine_similarity；max(align)=1.0
            aligns = [cosine_similarity(b, e_anchor) for b in beliefs]
            st = 1.0 - std_pop(aligns) / 1.0
            st = clamp(st, 0.0, 1.0)
            # CQ：锚点候选是否落在末轮候选集
            last_ids = {c.candidate_id for c in sK.candidates}
            cq = 1 if anchor_id in last_ids else 0
        else:
            # 兜底：未锚定，anchor 相关项不参与评分。
            # R/St 填 0.0 保持数值契约，参与与否由 anchored=False 承载（A3）。
            r = 0.0
            st = 0.0
            cq = 0

        # ---- 同族归一化打分（统一替换原先的锚定/未锚定两条分支）----
        # 任一项不可用时从分母剔除其权重，其余项按剩余权重和归一化，
        # 故任何组合下满分恒为 100、各项相对重要性不变。
        terms: List[tuple] = []  # (有效权重, 项值)
        if sc_opt is not None:
            # 收缩族内拆分：CR 让出 W_SEM 给 SC
            terms.append((w["w1"] - W_SEM, cr))
            terms.append((W_SEM, sc_opt))
        else:
            # SC 不可用 → 权重回落给同族 CR，得完整 w1（= 旧代码行为）
            terms.append((w["w1"], cr))
        if anchored:
            terms.append((w["w2"], 1.0 - r))
            terms.append((w["w3"], st))

        denom = sum(weight for weight, _ in terms)
        # 未锚定路径此前不归一化（score = 100·w1·CR），导致未锚定分数上限被
        # 硬压在 100·w1 = 40 —— 一个 CR=1.0 的完美收缩 trace 只因缺人类背书
        # 就被判 40 分，无法解释。那是 bug 而非设计意图，此处一并修复：
        # 归一化后未锚定满分恢复为 100。此为**刻意的行为变更**，未锚定 trace
        # 分数会整体上移，已在 docs/api/contracts.md 公示，避免协作者聚合端
        # 把上移误判为回归。
        score = (
            100.0 * sum(weight * value for weight, value in terms) / denom
            if denom > 0
            else 0.0
        )

        # 可逆性
        per_turn = [clamp(len(t.candidates) / 3.0, 0.0, 1.0) for t in turns]
        rev = sum(per_turn) / len(per_turn) if per_turn else 0.0
        # 惩罚：末轮之前（index < len-1）出现坍缩到 1 候选
        for idx, t in enumerate(turns):
            if idx < len(turns) - 1 and len(t.candidates) == 1:
                rev *= COLLAPSE_PENALTY
                break
        rev = clamp(rev, 0.0, 1.0)

        return ConvergenceScore(
            run_id=trace.run_id,
            agent_id=trace.agent_id,
            contraction_rate=round(cr, 6),
            residual=round(r, 6),
            stability=round(st, 6),
            anchored=anchored,
            # 「没算」时填 0.0 保数值契约，真假由 semantic_scored 承载
            semantic_contraction=sc_opt if sc_opt is not None else 0.0,
            semantic_scored=sc_opt is not None,
            unknowns_delta=unknowns_delta,
            convergence_score=round(score, 4),
            reversibility=round(rev, 6),
            convergence_quality=cq,
            weights=w,
            ts=_now_iso(),
            # A2：任一轮为投影/合成，整条分数即被污染，取最保守值。
            source="measured"
            if all(t.source == "measured" for t in turns)
            else "projected",
            synthetic=any(t.synthetic for t in turns),
        )


def l2_distance(a: List[float], b: List[float]) -> float:
    """欧氏距离 ||a − b||。

    维度不等时抛 ValueError（A4）：zip 会静默截断到较短的一方，
    让维度错配的 embedding 也能算出一个看似合理的距离。
    """
    if len(a) != len(b):
        raise ValueError(f"l2_distance 维度不匹配：{len(a)} vs {len(b)}")
    return math.sqrt(sum((x - y) * (x - y) for x, y in zip(a, b)))
