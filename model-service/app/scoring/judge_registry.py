"""
model-service/app/scoring/judge_registry.py
Tier 2 评分模块的注册表 + 单一派发点（JudgeRegistry）。

职责：
- register(ev)   注册一个 Evaluator，重名报错，维度越界报错；
- get(id)        取单个 Evaluator；
- list_ids()     列出已注册 id；
- dispatch(id, inp)  单一派发：校验工种适用性后转交 evaluate()。

为什么不用 import 直连：此前各评分模块各自 import、各自被直接调用，新增一个引擎
就多一条独立调用链，维度/派发路径随之发散。收口到 Registry 后，所有主观评分只经
dispatch() 一个入口，CI 用测试强制「新增必注册」（见 tests/test_registry.py）。

单一规则源：注册时校验 Evaluator 产出维度 ⊆ registry 允许维度，杜绝 Evaluator 自定维度。

零新增依赖。
"""
from __future__ import annotations

import logging
from typing import Dict, List

from .evaluator_protocol import (
    Evaluator,
    EvaluatorInput,
    EvaluatorOutput,
    allowed_dims_for,
)

logger = logging.getLogger("serve")


class JudgeRegistry:
    """Tier 2 评分模块注册表 + 单一派发点。"""

    def __init__(self) -> None:
        self._evaluators: Dict[str, Evaluator] = {}

    def register(self, ev: Evaluator) -> None:
        """注册一个 Evaluator。

        两道校验：
        1. 重名即报错——防止静默覆盖已有 Evaluator；
        2. 产出维度必须是 registry 允许维度的子集——杜绝 Evaluator 自定维度。
           （craft 维仅在对应工种下合法，故按 applicable_jobs 逐一校验。）
        """
        eid = getattr(ev, "evaluator_id", None)
        if not eid or not isinstance(eid, str):
            raise ValueError("Evaluator 必须提供非空字符串 evaluator_id")
        if eid in self._evaluators:
            raise ValueError(f"Evaluator '{eid}' 已注册，禁止重复注册")
        jobs = list(getattr(ev, "applicable_jobs", []) or [])
        if not jobs:
            raise ValueError(f"Evaluator '{eid}' 未声明 applicable_jobs")
        # 维度越界校验：Evaluator 不得自定 registry 以外的维度。
        # 声明维度集合（若 Evaluator 暴露 declared_dims 则用之，否则跳过静态校验，
        # 改为运行期由 dispatch 后消费者核对）。
        declared = getattr(ev, "declared_dims", None)
        if declared is not None:
            allowed: set = set()
            for jt in jobs:
                allowed |= allowed_dims_for(jt)
            extra = set(declared) - allowed
            if extra:
                raise ValueError(
                    f"Evaluator '{eid}' 声明了越界维度 {sorted(extra)}，"
                    f"不在 registry 允许集内"
                )
        self._evaluators[eid] = ev
        logger.info("JudgeRegistry: 注册 Evaluator '%s'（工种 %s）", eid, jobs)

    def get(self, evaluator_id: str) -> Evaluator:
        if evaluator_id not in self._evaluators:
            raise KeyError(f"未注册的 Evaluator: '{evaluator_id}'")
        return self._evaluators[evaluator_id]

    def list_ids(self) -> List[str]:
        return list(self._evaluators.keys())

    def dispatch(self, evaluator_id: str, inp: EvaluatorInput) -> EvaluatorOutput:
        """单一派发点：校验工种适用性后转交 evaluate()。"""
        ev = self.get(evaluator_id)
        if inp.job_type not in getattr(ev, "applicable_jobs", []):
            raise ValueError(
                f"Evaluator '{evaluator_id}' 不适用于工种 '{inp.job_type}'"
            )
        return ev.evaluate(inp)


# 全局单例 ---------------------------------------------------------------
_REGISTRY = JudgeRegistry()


def get_registry() -> JudgeRegistry:
    """取全局 JudgeRegistry 单例。"""
    return _REGISTRY
