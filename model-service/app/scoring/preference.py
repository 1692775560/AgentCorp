"""
model-service/app/scoring/preference.py
偏好回灌。

职责：
- aggregate_preference(signals, craft_scores_by_agent=None) -> PreferenceProfile
  把一次/多次拖拽信号聚合为 dimLift（通用六维提升量）：
    · 对每个 direction=="up" 的被提升 agent，取其「最强 craft 维」
      （由信号携带的 craftScores 决定；缺省回退为该 jobType 全部 craft 维的关联）
    · 经 registry.craft_links(dim) 映射得到关联通用六维 → dimLift[g] += 1
- apply_to_user_preference(weight, dim_lift, alpha=0.15, N=None) -> dict
  回灌 UserPreference.weight（仅改通用六维权重，不改 subjective 计算）：
    w'[d] = weight[d] * (1 + α · dimLift[d] / N)，再 normalize(Σ=1)
  R1 门控：dimLift 仅当累计信号 N >= 3 才生效；否则返回原 weight
           并记录 pending（由调用方标记）。

公式与前端 src/engine/scoring/* 镜像（R3 对拍）。零新增依赖。
"""
from __future__ import annotations

import datetime
from typing import Dict, List, Optional, Union

from ..schemas import PreferenceSignal, PreferenceProfile


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _sig_attr(sig: Union[PreferenceSignal, dict], key: str, default=None):
    """兼容 pydantic PreferenceSignal 与 dict。"""
    if isinstance(sig, dict):
        return sig.get(key, default)
    return getattr(sig, key, default)


def aggregate_preference(
    signals: List[Union[PreferenceSignal, dict]],
    craft_scores_by_agent: Optional[Dict[str, Dict[str, float]]] = None,
) -> PreferenceProfile:
    """
    聚合偏好信号 → PreferenceProfile（含 dimLift）。
    N = len(signals)（累计信号数，用于 R1 门控）。
    """
    craft_scores_by_agent = craft_scores_by_agent or {}
    N = len(signals)
    dim_lift: Dict[str, float] = {}
    pairwise_wins: Dict[str, int] = {}

    for sig in signals:
        agent_id = _sig_attr(sig, "agentId", "")
        direction = _sig_attr(sig, "direction", "up")
        job_type = _sig_attr(sig, "jobType", "code")

        if direction == "up":
            pairwise_wins[agent_id] = pairwise_wins.get(agent_id, 0) + 1

            # 仅 up 信号的被提升 agent 才计入 dimLift：
            # 确定其最强 craft 维 → 关联通用六维 → dimLift[g] += 1
            craft_scores = _sig_attr(sig, "craftScores", None)
            if not craft_scores and agent_id in craft_scores_by_agent:
                craft_scores = craft_scores_by_agent[agent_id]

            if craft_scores:
                # 最强 craft 维（得分最高）
                strongest = max(craft_scores.items(), key=lambda kv: kv[1])[0]
                links = _craft_links(strongest)
                for g in links:
                    dim_lift[g] = dim_lift.get(g, 0.0) + 1.0
            # 无 craftScores 且 agent 不在 craft_scores_by_agent 中：跳过该信号，不污染 dimLift

    return PreferenceProfile(
        ownerId=_sig_attr(signals[0], "ownerId", "default") if signals else "default",
        signals=[s if isinstance(s, PreferenceSignal) else PreferenceSignal(**s) for s in signals],
        pairwiseWins=pairwise_wins,
        dimLift=dim_lift,
        updatedAt=_now_iso(),
    )


def _craft_links(dim: str) -> List[str]:
    """craft 维 → 关联通用六维（import 延迟以避免循环依赖问题）。"""
    from .registry import craft_links

    return list(craft_links(dim))


def apply_to_user_preference(
    weight: Dict[str, float],
    dim_lift: Dict[str, float],
    alpha: float = 0.15,
    N: Optional[int] = None,
) -> Dict[str, float]:
    """
    回灌 UserPreference.weight（R1 门控 + α 加权 + 归一 Σ=1）。

    R1 门控：N < 3 时 dimLift 不生效，直接返回原 weight（调用方应标记 pending）。
    N >= 3：w'[d] = weight[d] * (1 + α · dimLift[d] / N)，再 normalize(Σ=1)。
    α 默认 0.15（上限 ±50% 相对由调用方/规则约束，本函数不强制裁剪）。
    """
    base = {k: float(v) for k, v in weight.items()}

    n = N if N is not None else int(sum(dim_lift.values()))
    if n < 3:
        # R1 门控：信号不足，原样返回（不回灌）
        return base

    new_w: Dict[str, float] = {}
    for d, w in base.items():
        lift = float(dim_lift.get(d, 0.0))
        new_w[d] = w * (1.0 + alpha * lift / float(n))

    s = sum(new_w.values())
    if s > 0:
        new_w = {k: v / s for k, v in new_w.items()}
    return new_w
