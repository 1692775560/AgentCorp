"""
model-service/app/scoring/registry.py
维度注册表（T0，架构 §3.1 / PRD §2）。

设计要点（架构 §7 共享约定）：
- 六维基线唯一真相：RADAR_DIMS（镜像 evaluator.RADAR_DIMS），任何 craft/sub
  维不得占用这六个键名。
- 前缀隔离：craft 维 img_* / txt_* / code_*；主观维 sub_*（PRD §2.4）。
- 全部为纯 Python 常量 + 一个小辅助函数，**零新增依赖**。
- JOB_GENERIC_WEIGHT 为按工种差异化的通用六维权重（Σ=1，仅通用六维内部），
  对应 owner 决策 Q2（image 重 creativity、text 重 comm/quality、code 重 reliability/cost）。
  注：flatten_dim_weight 在 T1 中已优先消费本常量（Q2 真正生效），
  仅在 registry 未提供该工种时才回退 rules JSON 的阶段级 genericRadarWeight。
"""
from __future__ import annotations

from typing import Dict, List


# ======================================================================
# 1) 六维基线（复用 evaluator.RADAR_DIMS，前后端同源）
# ======================================================================
RADAR_DIMS: List[str] = [
    "task",
    "quality",
    "comm",
    "creativity",
    "reliability",
    "cost",
]


# ======================================================================
# 2) 工种 craft 维度注册表（前缀隔离，PRD §2.2）
# ======================================================================
JOB_CRAFT_DIMS: Dict[str, List[str]] = {
    "image": [
        "img_composition",
        "img_style_fit",
        "img_fidelity",
        "img_aesthetic_consistency",
        "img_multimodal_follow",
    ],
    "text": [
        "txt_factuality",
        "txt_coherence",
        "txt_tone_fit",
        "txt_info_density",
        "txt_instruction_follow",
    ],
    "code": [
        "code_runnability",
        "code_efficiency",
        "code_test_coverage",
        "code_maintainability",
        "code_security",
    ],
}


# ======================================================================
# 3) 主观维度注册表（分阶段启用，PRD §2.4）
# ======================================================================
SUBJECTIVE_DIMS: Dict[str, List[str]] = {
    "preScreen": ["sub_potential", "sub_aesthetic_lean"],
    "interview": ["sub_task_feel", "sub_communication", "sub_surprise"],
    "performance": ["sub_trust", "sub_rehire", "sub_aesthetic_lean"],
}


# ======================================================================
# 4) 工种通用六维权重（owner 决策 Q2，Σ=1，仅通用六维内部；架构 §3.1）
# ======================================================================
JOB_GENERIC_WEIGHT: Dict[str, Dict[str, float]] = {
    "image": {"task": 0.18, "quality": 0.17, "comm": 0.15, "creativity": 0.17, "reliability": 0.17, "cost": 0.16},
    "text":  {"task": 0.18, "quality": 0.17, "comm": 0.18, "creativity": 0.12, "reliability": 0.18, "cost": 0.17},
    "code":  {"task": 0.18, "quality": 0.17, "comm": 0.12, "creativity": 0.13, "reliability": 0.20, "cost": 0.20},
}


# ======================================================================
# 5) Q6 强制真实执行/扫描标记（注册表标注 requiresReal）
#    code_runnability（需 CI/构建）/ code_security（需扫描）缺真实结果时，
#    由 T4 stage_scorer 对该维权重 ×0.4（本批次仅在 registry 标注，
#    完整降权逻辑在 T4，不在本批次越界实现）。
# ======================================================================
CRAFT_REQUIRES_REAL: Dict[str, bool] = {
    "code_runnability": True,
    "code_security": True,
}


# ======================================================================
# 6) craft 维 → 关联通用六维映射（用于偏好回灌，架构 §7.10 / PRD §2.2）
#    精确按 PRD §2.2 主映射表的「关联通用六维」逐维给出。
# ======================================================================
CRAFT_LINKS: Dict[str, List[str]] = {
    # 图像 agent
    "img_composition": ["quality", "creativity"],
    "img_style_fit": ["quality", "task"],
    "img_fidelity": ["quality", "reliability"],
    "img_aesthetic_consistency": ["creativity", "quality"],
    "img_multimodal_follow": ["task", "reliability"],
    # 文本 agent
    "txt_factuality": ["reliability", "quality"],
    "txt_coherence": ["quality", "comm"],
    "txt_tone_fit": ["comm", "quality"],
    "txt_info_density": ["comm", "creativity"],
    "txt_instruction_follow": ["task", "reliability"],
    # 代码 agent
    "code_runnability": ["task", "reliability"],
    "code_efficiency": ["cost", "quality"],
    "code_test_coverage": ["reliability", "quality"],
    "code_maintainability": ["quality", "creativity"],
    "code_security": ["reliability", "cost"],
}


def craft_links(dim: str) -> List[str]:
    """
    craft 维 → 关联通用六维（用于偏好回灌 / 加权映射，架构 §7.10）。

    若 dim 不在 CRAFT_LINKS（如通用六维本身或非 craft 键），
    返回空列表。job 级默认映射（image→[creativity,quality]、
    text→[quality,comm]、code→[reliability,cost]）可由前缀推导，
    但此处优先返回 PRD §2.2 的逐维精确映射。
    """
    return list(CRAFT_LINKS.get(dim, []))


def job_type_of_craft(dim: str) -> str:
    """由 craft 维前缀推断工种（img_→image / txt_→text / code_→code）。"""
    if dim.startswith("img_"):
        return "image"
    if dim.startswith("txt_"):
        return "text"
    if dim.startswith("code_"):
        return "code"
    return "code"
