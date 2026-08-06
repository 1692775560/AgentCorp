"""
model-service/app/scoring/__init__.py
评估层扩展核心包（架构 §1.3 / T0–T3 / T13–T18）。

本批次在批次 1（registry / rules_engine）之上，追加 Layer3 收敛类模块：
- encoder：确定性投影编码器 + 纯 Python PCA + ConvergenceConfig（T14）
- convergence：收敛数据模型 + ConvergenceEngine（T13 / T15）

零新增运行时依赖（纯 Python + pydantic）。
"""
from __future__ import annotations

from .registry import (
    RADAR_DIMS,
    JOB_CRAFT_DIMS,
    SUBJECTIVE_DIMS,
    JOB_GENERIC_WEIGHT,
    CRAFT_REQUIRES_REAL,
    CRAFT_LINKS,
    craft_links,
)
from .rules_engine import (
    load_rules,
    flatten_dim_weight,
    compute_stage_score,
    verdict_from_total,
)
from .stage_scorer import build_stage_score
from .preference import (
    aggregate_preference,
    apply_to_user_preference,
)
from .task_sets import (
    TaskSet,
    TaskSetRegistry,
    UsageEfficiencyTaskSet,
    get_task_set,
    list_task_sets,
)
from .encoder import (
    encode_summary,
    pca2d,
    ConvergenceConfig,
    cosine_similarity,
)
from .convergence import (
    CandidateEmbedding,
    TurnState,
    ConvergenceTrace,
    HumanAnchor,
    ConvergenceScore,
    ConvergenceEngine,
    ConvSource,
)

__all__ = [
    # registry
    "RADAR_DIMS",
    "JOB_CRAFT_DIMS",
    "SUBJECTIVE_DIMS",
    "JOB_GENERIC_WEIGHT",
    "CRAFT_REQUIRES_REAL",
    "CRAFT_LINKS",
    "craft_links",
    # rules_engine
    "load_rules",
    "flatten_dim_weight",
    "compute_stage_score",
    "verdict_from_total",
    # stage_scorer (T4)
    "build_stage_score",
    # preference (T8)
    "aggregate_preference",
    "apply_to_user_preference",
    # task_sets (T9)
    "TaskSet",
    "TaskSetRegistry",
    "UsageEfficiencyTaskSet",
    "get_task_set",
    "list_task_sets",
    # encoder (T14)
    "encode_summary",
    "pca2d",
    "ConvergenceConfig",
    "cosine_similarity",
    # convergence (T13 / T15)
    "CandidateEmbedding",
    "TurnState",
    "ConvergenceTrace",
    "HumanAnchor",
    "ConvergenceScore",
    "ConvergenceEngine",
    "ConvSource",
]
