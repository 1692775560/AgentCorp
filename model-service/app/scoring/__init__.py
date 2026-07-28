"""
model-service/app/scoring/__init__.py
评估层扩展核心包（架构 §1.3 / T0–T3）。

本批次仅导出地基模块：registry（维度注册表）、rules_engine（规则引擎）。
后续批次（T4+）将在此追加 stage_scorer / preference / task_sets。

T0–T3 不引入任何新运行时依赖（纯 Python + pydantic，见架构 §6.1）。
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
]
