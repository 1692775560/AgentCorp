"""
model-service/app/scoring/stage_scorer.py
三阶段评分卡装配。

职责：
- build_stage_score(stage, job_type, objective, subjective, craft_evidence, rules)
  → 装配一个 StageScore-like dict（S1/S2/S3 同构）。
  - 客观分：复用 rules_engine.flatten_dim_weight，
    加权求和 objective[dim]/5 × dimWeight[dim] × 100。
  - Q6 降权：code_runnability / code_security 缺真实执行/扫描证据时，该维
    dimWeight × 0.4，其余维归一（保证 Σ=1 不变），并在 evidence 标注
    「缺真实结果·降权」。
  - Q7 craft 独立写库：craft 维除并入 objective（按 flatten 预折叠）外，
    单独抽出存入 StageScore.craftScores（CraftScores），供工种 craft 雷达
    独立对比，不污染通用六维 objective 记录。
  - 主观分：等权（启用主观维数），阶段级 objW/subjW 加权得 total；
    verdict 走 verdict_from_total（Q4）。

零新增依赖（纯 Python + pydantic）。
"""
from __future__ import annotations

import datetime
from typing import Dict, List, Optional

from ..schemas import Verdict
from .registry import JOB_CRAFT_DIMS, CRAFT_REQUIRES_REAL
from .rules_engine import (
    load_rules,
    flatten_dim_weight,
    verdict_from_total,
)
from ..schemas import (
    ObjectiveScoreItem,
    SubjectiveScore,
    CraftScores,
    StageScore,
)


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def build_stage_score(
    stage: str,
    job_type: str,
    objective: Dict[str, float],
    subjective: Dict[str, float],
    craft_evidence: Optional[Dict[str, str]] = None,
    rules: Optional[dict] = None,
    agent_id: str = "unknown",
    scored_by: str = "owner",
    window: Optional[str] = None,
    preset_id: str = "default",
) -> dict:
    """
    装配单阶段评分卡（S1/S2/S3 同构）。

    参数：
      stage: preScreen / interview / performance
      job_type: image / text / code
      objective: {dim: 0–5}（通用六维 + 本工种 craft 维）
      subjective: {sub_*: 0–5}（本阶段启用主观维）
      craft_evidence: {craft_dim: evidence_text}；缺失键 → 视为缺真实结果（Q6 降权）
      rules: 规则 dict（缺省按 preset_id 加载）
    返回：StageScore.model_dump(mode="json") 字典。
    """
    rules = rules or load_rules(preset_id)
    craft_evidence = craft_evidence or {}

    # —— 1) 预折叠权重——
    dw = dict(flatten_dim_weight(stage, job_type, rules))

    # —— 2) Q6 降权：requires_real 维缺真实证据 → ×0.4，再归一 Σ=1 不变 ——
    downweighted: List[str] = []
    evidence_map: Dict[str, str] = {}
    for dim, w in list(dw.items()):
        if CRAFT_REQUIRES_REAL.get(dim) and dim not in craft_evidence:
            dw[dim] = w * 0.4
            downweighted.append(dim)
            evidence_map[dim] = "缺真实结果·降权"
    total_w = sum(dw.values())
    if total_w > 0:
        dw = {k: v / total_w for k, v in dw.items()}

    # —— 3) 客观分（加权）——
    objective_items: List[ObjectiveScoreItem] = []
    obj_acc = 0.0
    for dim, w in dw.items():
        score = float(objective.get(dim, 0.0))
        obj_acc += (score / 5.0) * w
        src = "mixed" if dim.startswith(("img_", "txt_", "code_")) else "judge"
        objective_items.append(
            ObjectiveScoreItem(
                dim=dim,
                score=round(score, 3),
                source=src,
                weight=round(w, 6),
                evidence=evidence_map.get(dim),
            )
        )
    objective_score = round(obj_acc * 100.0, 1)

    # —— 4) 主观分（等权）——
    stage_cfg = rules["stages"][stage]
    sub_dims = stage_cfg.get("enabledSubjective", [])
    n_sub = len(sub_dims) or 1
    sub_acc = 0.0
    for d in sub_dims:
        sub_acc += (float(subjective.get(d, 0.0)) / 5.0) * (1.0 / n_sub)
    subjective_score = round(sub_acc * 100.0, 1)

    # —— 5) 总分 + verdict（Q4）——
    ow = float(stage_cfg.get("objectiveWeight", 0.5))
    sw = float(stage_cfg.get("subjectiveWeight", 0.5))
    total = round(objective_score * ow + subjective_score * sw, 1)
    verdict = verdict_from_total(total, rules, stage)
    verdict_val = verdict.value if isinstance(verdict, Verdict) else str(verdict)

    # —— 6) Q7 craft 独立写库（CraftScores）——
    craft_dims = JOB_CRAFT_DIMS.get(job_type, [])
    craft_dims_present = [d for d in craft_dims if d in objective]
    craft_score_map = {d: float(objective.get(d, 0.0)) for d in craft_dims_present}
    craft = CraftScores(
        jobType=job_type,
        dims=craft_score_map,
        downweighted=downweighted,
        evidence=evidence_map,
    )

    # —— 7) 组装 StageScore ——
    sub_model = SubjectiveScore(
        agentId=agent_id,
        stage=stage,
        scores=dict(subjective),
        scoredBy=scored_by,
        ts=_now_iso(),
    )
    ss = StageScore(
        agentId=agent_id,
        stage=stage,
        jobType=job_type,
        objective=objective_items,
        subjective=sub_model,
        objectiveWeight=ow,
        subjectiveWeight=sw,
        objectiveScore=objective_score,
        subjectiveScore=subjective_score,
        total=total,
        verdict=verdict_val,
        craftScores=craft,
        window=window,
        ts=_now_iso(),
    )
    return ss.model_dump(mode="json")
