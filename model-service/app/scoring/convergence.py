"""
model-service/app/scoring/convergence.py
收敛数据模型（T13）+ 收敛引擎（T15，架构 §3.3 / §3.5 / §5.1）。

- 数据模型（Pydantic）：CandidateEmbedding / TurnState / ConvergenceTrace /
  HumanAnchor / ConvergenceScore，字段与前端的 src/types/convergence.ts 严格镜像，
  且全部带 conv_ 命名空间意念（独立模型名，绝不占用 RADAR_DIMS /
  StageScore / DualLeaderboard / KpiRecord / RoiSnapshot 既有键，架构 §0 红线）。
- 引擎 ConvergenceEngine：record_turn / set_anchor / compute_convergence_score，
  严格按架构 §3.5 公式（CR / R / St / CQ / convergence_score / Reversibility）。

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
# 1) 数据模型（T13，架构 §5.1）
# ======================================================================
class CandidateEmbedding(BaseModel):
    """单候选的潜在 embedding（每轮 agent 产出）。"""

    model_config = _CONV_CONFIG

    candidate_id: str
    turn: int  # 0 = S₀（初始），1..K
    summary_text: str  # "需求理解摘要" 原文
    embedding: List[float]  # 编码器输出（默认 d=64）
    job_type: str = "code"  # 复用既有 JobType 意念（image/text/code）


class TurnState(BaseModel):
    """单轮状态（候选集 + agent 的 belief embedding）。"""

    model_config = _CONV_CONFIG

    turn: int
    candidates: List[CandidateEmbedding]  # 该轮候选（建议 3–7，保可逆性）
    belief_embedding: List[float]  # agent "它以为你要什么" 的 embedding
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
# 2) 收敛引擎（T15，架构 §3.5）
# ======================================================================
# 末轮前坍缩到 1 候选的惩罚系数（可逆性，架构 §3.3 构件 2）
COLLAPSE_PENALTY = 0.5


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

    # ---- T15：记录 / 锚点 ----
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

    # ---- T15：核心评分 ----
    def compute_convergence_score(
        self, trace: ConvergenceTrace
    ) -> ConvergenceScore:
        """
        按架构 §3.5 公式：

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
            score = 100.0 * (w["w1"] * cr + w["w2"] * (1.0 - r) + w["w3"] * st)
        else:
            # 兜底：未锚定，anchor 相关项不参与评分。
            # R/St 填 0.0 保持数值契约，参与与否由 anchored=False 承载（A3）。
            r = 0.0
            st = 0.0
            cq = 0
            score = 100.0 * (w["w1"] * cr)

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
