"""
model-service/app/scoring/rules_engine.py
规则引擎（T1，架构 §3.2 / §7.8 / 类图 RulesEngine）。

职责（仅本批次，不越界到 T4 完整评分卡装配）：
- load_rules(preset_id)：从 presets/*.json 加载规则（缺省回退 default.json）。
- flatten_dim_weight(stage, job_type, rules)：把「两层级权重」预折叠为
  扁平 dimWeight（Σ=1，仅含本阶段启用客观维）。
- compute_stage_score(objective, subjective, rules, stage[, job_type])：
  按 PRD §10 公式 + 架构 §3.2 计算客观分/主观分/总分/verdict。
- verdict_from_total(total[, rules, stage])：Q4 阈值映射。

零新增依赖（纯 Python + pydantic 的 Verdict 枚举复用）。
"""
from __future__ import annotations

import json
import os
from typing import Dict, List, Optional

from ..schemas import Verdict

_PRESETS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "presets")


# ======================================================================
# 1) 规则加载
# ======================================================================
def load_rules(preset_id: str = "default") -> dict:
    """
    加载指定预设规则 JSON；若预设文件不存在则回退 default.json。
    找不到任何预设时抛 FileNotFoundError（上层捕获，不静默）。
    """
    target = os.path.join(_PRESETS_DIR, f"{preset_id}.json")
    if not os.path.isfile(target):
        target = os.path.join(_PRESETS_DIR, "default.json")
    if not os.path.isfile(target):
        raise FileNotFoundError(
            f"规则预设缺失：既无 {preset_id}.json 也无 default.json（期望目录 {_PRESETS_DIR}）"
        )
    with open(target, "r", encoding="utf-8") as fh:
        return json.load(fh)


# ======================================================================
# 2) 权重预折叠（架构 §7.8）
# ======================================================================
def _detect_job_type(objective: Dict[str, float]) -> str:
    """由 objective 中的 craft 维前缀推断工种（无 craft 维默认 code）。"""
    for dim in objective:
        if dim.startswith("img_"):
            return "image"
        if dim.startswith("txt_"):
            return "text"
        if dim.startswith("code_"):
            return "code"
    return "code"


def flatten_dim_weight(stage: str, job_type: str, rules: dict) -> Dict[str, float]:
    """
    按架构 §3.2 + §7.8 预折叠为扁平 dimWeight（Σ=1，仅含本阶段启用客观维）。

    公式：
      generic 块：genericRadarWeight[dim] × objectiveBlockWeight.generic
      craft   块：objectiveBlockWeight.craft 均分给 jobs[job_type].craftDims
      kpiRoi  块：performance 阶段预留（本批次无 kpi/roi 维 → 占位 0 维）
      最后整体归一化使 Σ=1（保证缺 kpiRoi 维时不会 <1）。

    约定（架构 §7.8）：__generic__ = genericRadar；__craft__ = 当前 jobType.craftDims。
    """
    stage_cfg = rules["stages"][stage]
    bw = stage_cfg.get("objectiveBlockWeight", {})
    generic_w = stage_cfg.get("genericRadarWeight", {})
    generic_block = float(bw.get("generic", 0.0))
    craft_block = float(bw.get("craft", 0.0))

    job_cfg = rules.get("jobs", {}).get(job_type, {})
    craft_dims = job_cfg.get("craftDims", [])

    raw: Dict[str, float] = {}
    # —— generic 块 ——
    for dim, w in generic_w.items():
        raw[dim] = float(w) * generic_block
    # —— craft 块（均分）——
    if craft_dims:
        per = craft_block / len(craft_dims)
        for d in craft_dims:
            raw[d] = per
    # —— kpiRoi 块：本批次占位（无维度），归一时自动把其份额
    #    重新分配给 generic + craft，保持 Σ=1（见下方归一）。

    total = sum(raw.values())
    if total <= 0:
        return raw
    return {k: v / total for k, v in raw.items()}


# ======================================================================
# 3) 阶段计分（PRD §10 公式 + 架构 §3.2）
# ======================================================================
def compute_stage_score(
    objective: Dict[str, float],
    subjective: Dict[str, float],
    rules: dict,
    stage: str,
    job_type: Optional[str] = None,
) -> dict:
    """
    计算单阶段评分卡核心（客观分/主观分/总分/verdict）。

    objectiveScore = Σ(objective[dim]/5 × dimWeight[dim]) × 100
      其中 dimWeight = flatten_dim_weight(stage, job_type, rules)
      （objective 中缺失的 dimWeight 维按 0 计；dimWeight 中多出的维忽略）
    subjectiveScore = Σ(subjective[dim]/5 × 1/|subjectiveDims|) × 100
      （主观维等权；enabledSubjective 来自 rules[stage]）
    total = objectiveScore × objectiveWeight(stage) + subjectiveScore × subjectiveWeight(stage)
    verdict = verdict_from_total(total, rules, stage)  （Q4：≥78 MVP / 50–78 OBSERVE / <50 FIRED）

    job_type 可显式传入；缺省时由 objective 中 craft 维前缀自动推断。
    """
    job_type = job_type or _detect_job_type(objective)
    stage_cfg = rules["stages"][stage]
    dim_weight = flatten_dim_weight(stage, job_type, rules)

    # 客观分（加权）
    obj_acc = 0.0
    for dim, w in dim_weight.items():
        score = float(objective.get(dim, 0.0))
        obj_acc += (score / 5.0) * w
    objective_score = round(obj_acc * 100.0, 1)

    # 主观分（等权）
    sub_dims = stage_cfg.get("enabledSubjective", [])
    n_sub = len(sub_dims) or 1
    sub_acc = 0.0
    for d in sub_dims:
        score = float(subjective.get(d, 0.0))
        sub_acc += (score / 5.0) * (1.0 / n_sub)
    subjective_score = round(sub_acc * 100.0, 1)

    # 总分
    ow = float(stage_cfg.get("objectiveWeight", 0.5))
    sw = float(stage_cfg.get("subjectiveWeight", 0.5))
    total = round(objective_score * ow + subjective_score * sw, 1)

    verdict = verdict_from_total(total, rules, stage)

    return {
        "objectiveScore": objective_score,
        "subjectiveScore": subjective_score,
        "total": total,
        "verdict": verdict,
        "jobType": job_type,
        "stage": stage,
        "dimWeight": dim_weight,
    }


# ======================================================================
# 4) verdict 映射（Q4）
# ======================================================================
def verdict_from_total(
    total: float,
    rules: Optional[dict] = None,
    stage: Optional[str] = None,
) -> Verdict:
    """
    total → Verdict（架构 §7.4 / Q4）：
      ≥ mvp(默认78)        → MVP
      78 > total ≥ observe(50) → OBSERVE
      < observe               → FIRED
    阈值优先取 rules[stage].thresholds（m vp / obse rve），否则用 Q4 默认。
    """
    mvp, observe = 78, 50
    if rules and stage and stage in rules.get("stages", {}):
        th = rules["stages"][stage].get("thresholds", {})
        mvp = float(th.get("mvp", mvp))
        observe = float(th.get("observe", observe))

    if total >= mvp:
        return Verdict.MVP
    if total >= observe:
        return Verdict.OBSERVE
    return Verdict.FIRED
