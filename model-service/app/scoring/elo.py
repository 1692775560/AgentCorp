"""
model-service/app/scoring/elo.py
Arena 双轨 Elo 纯函数。

零依赖、确定性、可单测：
    expected(r_a, r_b) = 1 / (1 + 10 ** ((r_b - r_a) / 400))
    update(rating, expected_score, actual_score, k) = rating + k * (actual_score - expected_score)

两套 Elo（同库不同键，调用方各自维护）：
- 主观 Elo（主榜）：用户选择驱动，score_A = 1/0.5/0（win/draw/lose）；
  none 不计分（调用方直接跳过）。k=16。
- 客观 Elo（辅榜，可选）：LLM 分差归一化胜率分数
  score_A = 1 / (1 + 10 ** ((obj_B - obj_A) / 2.0))。k=8。

k-factor 乘 user_weight ∈ (0,1]（本地默认 1.0，契约预留 ownerId/weight）。
rating 初始 1000，钳制 [100, 3000]。
"""
from __future__ import annotations

from typing import Dict, Optional, Tuple

INITIAL_RATING = 1000.0
MIN_RATING = 100.0
MAX_RATING = 3000.0

SUBJECTIVE_K = 16.0
OBJECTIVE_K = 8.0

# 用户主观选择 → 实际分数（A 视角）
WIN_SCORE = 1.0
DRAW_SCORE = 0.5
LOSE_SCORE = 0.0


def clamp_rating(rating: float) -> float:
    """钳制到 [MIN_RATING, MAX_RATING]。"""
    return max(MIN_RATING, min(MAX_RATING, rating))


def expected(r_a: float, r_b: float) -> float:
    """A 对 B 的预期胜率（标准 Elo 公式）。"""
    return 1.0 / (1.0 + 10.0 ** ((r_b - r_a) / 400.0))


def update(rating: float, expected_score: float, actual_score: float, k: float) -> float:
    """单侧 Elo 更新（先钳制后再计算，保证上下界不被 k 放大破坏）。"""
    return clamp_rating(rating + k * (actual_score - expected_score))


def subjective_actual(pick: str, agent_a: str, agent_b: str) -> Optional[float]:
    """
    用户选择 → A 的实际分数（主观轨）。
    - pick == agent_a：A 胜（1.0）
    - pick == 'draw'：平局（0.5）
    - pick == agent_b：A 负（0.0）
    - pick == 'none'：无效对局（返回 None，调用方不更新）
    - 其他（未知 agent / 非法值）：返回 None（调用方应视为校验失败）
    """
    if pick == agent_a:
        return WIN_SCORE
    if pick == agent_b:
        return LOSE_SCORE
    if pick == "draw":
        return DRAW_SCORE
    return None


def objective_actual(obj_a: float, obj_b: float) -> float:
    """客观轨 A 的胜率分数（LLM 分差归一化，避免分差小时硬判胜负）。"""
    return 1.0 / (1.0 + 10.0 ** ((obj_b - obj_a) / 2.0))


def update_pair(
    r_a: float,
    r_b: float,
    actual_a: float,
    k: float,
) -> Tuple[float, float]:
    """
    对局双方同时更新（预期胜率基于更新前 rating 计算，对称更新）。
    actual_a ∈ [0,1]；actual_b = 1 - actual_a。
    """
    exp_a = expected(r_a, r_b)
    exp_b = expected(r_b, r_a)
    new_a = update(r_a, exp_a, actual_a, k)
    new_b = update(r_b, exp_b, 1.0 - actual_a, k)
    return new_a, new_b


def apply_user_weight(k: float, user_weight: float = 1.0) -> float:
    """k' = k * user_weight；user_weight 必须 ∈ (0,1]。"""
    w = max(0.0, min(1.0, float(user_weight)))
    if w <= 0.0:
        w = 1.0  # 防御：0 权重视为默认 1.0
    return k * w


def resolve_winner(pick: str, candidates: Dict[str, float]) -> Optional[str]:
    """
    由用户选择解析胜者（用于回包 winner 字段）：
    - pick == 'draw' → 'draw'
    - pick in candidates → pick
    - pick == 'none' → None
    - 其他 → None（非法，调用方应 422）
    """
    if pick == "draw":
        return "draw"
    if pick in candidates:
        return pick
    return None
