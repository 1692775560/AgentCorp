"""
model-service/app/scoring/evaluator_protocol.py
Tier 2（主观评判层）评分模块的统一契约。

为什么需要它：此前 growth / enterpriseFit / arena_judge / craft_judge / sandbox
各自 import、各自被直接调用，未注册进任何统一契约——每加一个评分引擎就多一条
独立调用链，维度/权重/派发路径随之发散（「测量概念蔓延」）。本契约把所有主观评分
模块收口到同一份入参/出参/接口，让它们可被 JudgeRegistry 统一注册、校验、派发。

设计约束：
- 客观层（metricsEngine / roiEngine / convergence 等）不走这份契约，保持纯函数原样；
- 所有 Evaluator 产出的维度必须是 registry 允许维度的子集（CI 强制，见 test_registry）；
- 纯数据结构，无副作用、无外部依赖（只用 stdlib dataclass）。

学术依据：
- SWE-bench（arXiv:2310.06770）：评测应由「可复现的固定协议」驱动，而非各模块各自约定；
- HELM（Liang et al. 2022）：标准化多维度评测需要统一场景与统一度量口径。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Protocol, runtime_checkable


@dataclass
class EvaluatorInput:
    """所有 Evaluator 的统一入参（字段按需取用，不必全填）。"""

    agent_id: str
    job_type: str = "code"
    task_id: Optional[str] = None
    answer: Optional[str] = None            # 候选答案文本
    radar_scores: Optional[Dict[str, float]] = None
    craft_scores: Optional[Dict[str, float]] = None
    requirement: Optional[str] = None       # arena 需求文本
    verified_evidence: Optional[Dict[str, str]] = None
    options: Optional[Dict[str, Any]] = None


@dataclass
class EvaluatorOutput:
    """所有 Evaluator 的统一产出。"""

    evaluator_id: str                        # 注册名（如 "craft_judge"）
    scores: Dict[str, float] = field(default_factory=dict)        # {dim: 0–5}
    verified_evidence: Dict[str, str] = field(default_factory=dict)  # 机器可核验证据
    craft_evidence: Dict[str, str] = field(default_factory=dict)     # 裁判引文
    confidence: float = 0.0
    reasoning: str = ""                      # 思维链（供审计）
    metadata: Dict[str, Any] = field(default_factory=dict)        # 扩展字段


@runtime_checkable
class Evaluator(Protocol):
    """Tier 2 评分模块的统一契约。

    实现者须提供：
      evaluator_id:      全局唯一注册名
      applicable_jobs:   适用的工种列表（如 ["code"]）
      evaluate(inp):     把 EvaluatorInput 转为 EvaluatorOutput
    """

    evaluator_id: str
    applicable_jobs: List[str]

    def evaluate(self, inp: EvaluatorInput) -> EvaluatorOutput: ...


def allowed_dims_for(job_type: str) -> set:
    """某工种下 registry 允许的全部维度（通用六维 + 本工种 craft 维）。

    供 registry 注册时校验 Evaluator 产出维度不越界。
    """
    from .registry import JOB_CRAFT_DIMS, RADAR_DIMS

    dims = set(RADAR_DIMS)
    dims.update(JOB_CRAFT_DIMS.get(job_type, []))
    return dims
