"""
model-service/app/scoring/task_sets.py
Task-Set 可插拔（T9，架构 §3.7 / Q9）。

职责：
- TaskSet（Protocol）：id / title / description / applicableJobs / run(input, opts)
- TaskSetRegistry：register / get / list（可插拔扩展点）
- UsageEfficiencyTaskSet（内置）：复用 /api/evaluate-run 语义（_derive_run_radar），
  把真实 usage 派生为标准化 TaskRunResult（objectiveScores / telemetry / usage /
  craftEvidence / meta），供 scoring 引擎消费。本期不实现「有价值任务集」内容。
- get_task_set(id)：按 id 取注册表实例。

零新增依赖（纯 Python + pydantic）。前端 src/engine/scoring/taskSets.ts 镜像。
"""
from __future__ import annotations

import datetime
from typing import Dict, List, Optional, Protocol, runtime_checkable

from ..schemas import JudgeRunRequest, TaskRunResult, RadarScore
from .registry import RADAR_DIMS, JOB_CRAFT_DIMS


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


@runtime_checkable
class TaskSet(Protocol):
    """任务集抽象：管线无关，仅产出标准化 TaskRunResult。"""
    id: str
    title: str
    description: str
    applicableJobs: List[str]

    def run(self, input: JudgeRunRequest, opts: Optional[dict] = None) -> TaskRunResult:
        ...


class UsageEfficiencyTaskSet:
    """
    内置任务集：复用 /api/evaluate-run 语义（确定性派生雷达 + 真实 usage），
    产出 UsageEfficiency 视角的 TaskRunResult（性价比 / 稳定性 / 复现性占位）。
    """

    id = "usage_efficiency"
    title = "Usage Efficiency"
    description = (
        "复用 /api/evaluate-run 语义：基于真实 token 用量与 transcript 派生客观分，"
        "衡量 agent 在「又快又省 token（性价比）」约束下的产出质量。"
    )
    applicableJobs = ["image", "text", "code"]

    def run(self, input: JudgeRunRequest, opts: Optional[dict] = None) -> TaskRunResult:
        opts = opts or {}
        repeats = int(opts.get("repeats", 1) or 1)

        # 复用 evaluate-run 的确定性雷达派生（mock/真实落点一致）
        from ..evaluator import _derive_run_radar

        radar: RadarScore = _derive_run_radar(input)
        objective_scores: Dict[str, float] = {
            d: float(getattr(radar, d)) for d in RADAR_DIMS
        }

        usage = list(input.usage or [])
        total_cost = sum(float(u.get("costUsd", 0) or 0) for u in usage)
        total_tokens = sum(int(u.get("totalTokens", 0) or 0) for u in usage)

        # telemetry：由 usage 轻量派生（复用 JudgeRunInput 同义结构）
        telemetry = [
            {
                "agent_id": u.get("agentId", input.agent_id),
                "task_id": u.get("sessionId", "unknown"),
                "costUsd": float(u.get("costUsd", 0) or 0),
                "totalTokens": int(u.get("totalTokens", 0) or 0),
            }
            for u in usage
        ]

        # UsageEfficiency 任务集不评 craft 维；占位用 code 工种维度键仅为
        # 保持 TaskRunResult.craftEvidence 结构完整，不参与实际评分。
        craft_dims = JOB_CRAFT_DIMS.get("code", [])
        craft_evidence: Dict[str, str] = {
            d: "UsageEfficiency 不评估 craft 维（仅客观六维）" for d in craft_dims
        }

        meta = {
            "repeats": float(repeats),
            "costPerRun": (total_cost / repeats) if repeats > 0 else 0.0,
            "totalTokens": float(total_tokens),
            # 稳定性 / 复现性：本期占位（未来「有价值任务集」实现）
            "stability": 0.0,
        }

        return TaskRunResult(
            agentId=input.agent_id,
            taskSetId=self.id,
            jobType="code",
            objectiveScores=objective_scores,
            telemetry=telemetry,
            usage=usage,
            craftEvidence=craft_evidence,
            meta=meta,
        )


class TaskSetRegistry:
    """TaskSet 可插拔注册表。"""

    def __init__(self) -> None:
        self._registry: Dict[str, TaskSet] = {}

    def register(self, ts: TaskSet) -> None:
        self._registry[ts.id] = ts

    def get(self, task_set_id: str) -> Optional[TaskSet]:
        return self._registry.get(task_set_id)

    def list(self) -> List[TaskSet]:
        return list(self._registry.values())


# 进程内默认注册表（最小改动、向后兼容）
_REGISTRY = TaskSetRegistry()
_REGISTRY.register(UsageEfficiencyTaskSet())


def get_task_set(task_set_id: str) -> Optional[TaskSet]:
    return _REGISTRY.get(task_set_id)


def list_task_sets() -> List[TaskSet]:
    return _REGISTRY.list()
