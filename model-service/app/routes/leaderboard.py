"""批次2（T4–T9）端点：evaluate-stage / rules / leaderboard / preference（纯搬运自原 serve.py）。

这些端点共享进程内状态（_STAGE_STORE / _RULES_OVERRIDES），故同处一个模块。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import List, Optional

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse

# 批次2（T4–T9）：仅追加，不破坏既有端点（架构 §2.1 / 实现清单）。
from ..scoring.stage_scorer import build_stage_score
from ..scoring.preference import aggregate_preference, apply_to_user_preference
from ..scoring.rules_engine import load_rules, _PRESETS_DIR as _SCORING_PRESETS_DIR
from ..schemas import (
    StageScoreRequest,
    LeaderboardEntry,
    SubjectiveRankEntry,
    RankDivergence,
    DualLeaderboard,
    PreferenceProfile,
    PreferenceFeedbackRequest,
    ScoringRulesLoad,
    WeightVector,
)
from ._common import datetime_now_iso

logger = logging.getLogger("serve")

router = APIRouter()

# ======================================================================
# 批次2（T4–T9）内存 store（零新依赖，进程内）：
#   _STAGE_STORE[stage][jobType][agentId] = StageScore(dict)
#   _RULES_OVERRIDES[presetId] = rules dict（PUT /api/rules 落库）
# ======================================================================
_STAGE_STORE: dict = {}
_RULES_OVERRIDES: dict = {}


def _mock_leaderboard_entries(stage: str, job_type: str) -> list:
    """当无真实 StageScore 时生成确定性 mock 条目（保证端点可用）。"""
    samples = [
        ("agent-a", 82.0, 80.0),
        ("agent-b", 74.5, 72.0),
        ("agent-c", 61.0, 65.0),
    ]
    out = []
    for aid, obj, sub in samples:
        jt = job_type if job_type != "all" else "code"
        out.append((aid, jt, {
            "agentId": aid, "stage": stage, "jobType": jt,
            "objectiveScore": obj, "subjectiveScore": sub,
            "total": obj, "verdict": "MVP" if obj >= 78 else ("OBSERVE" if obj >= 50 else "FIRED"),
        }))
    return out


# ======================================================================
# 批次2 端点（T4–T9）：/api/evaluate-stage / /api/rules / /api/leaderboard / /api/preference
# 不破坏既有 /api/evaluate* 与 /api/convergence/* 端点。
# ======================================================================
@router.post("/api/evaluate-stage")
async def api_evaluate_stage(req: StageScoreRequest):
    """
    三阶段评分卡装配（T4）：接收客观分 + 主观分，装配 StageScore 并发 stage_score SSE 事件。
    SSE 事件：stage_score（携带 StageScore）→ done。
    """
    stage_score = build_stage_score(
        stage=req.stage,
        job_type=req.jobType,
        objective=req.objective,
        subjective=req.subjective,
        craft_evidence=req.craftEvidence,
        agent_id=req.agentId,
        scored_by=req.scoredBy,
        window=req.window,
        preset_id=req.presetId,
    )
    # 进程内落库（供 /api/leaderboard 拉取）
    _STAGE_STORE.setdefault(req.stage, {}).setdefault(req.jobType, {})[req.agentId] = stage_score

    async def event_gen():
        yield {
            "event": "stage_score",
            "data": json.dumps(stage_score, ensure_ascii=False),
        }
        await asyncio.sleep(0)
        yield {
            "event": "done",
            "data": json.dumps(
                {"evaluation_id": f"stage-{req.agentId}-{req.stage}"},
                ensure_ascii=False,
            ),
        }

    return EventSourceResponse(event_gen())


@router.get("/api/rules")
def api_get_rules(preset: str = "default") -> dict:
    """读取规则预设（T5）：优先内存覆盖，否则从 presets/<preset>.json 加载。"""
    if preset in _RULES_OVERRIDES:
        return _RULES_OVERRIDES[preset]
    return load_rules(preset)


@router.put("/api/rules")
def api_put_rules(req: ScoringRulesLoad) -> dict:
    """保存规则预设（T5）：写入内存 + 持久化到 presets/<presetId>.json。"""
    _RULES_OVERRIDES[req.presetId] = req.rules
    try:
        os.makedirs(_SCORING_PRESETS_DIR, exist_ok=True)
        path = os.path.join(_SCORING_PRESETS_DIR, f"{req.presetId}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(req.rules, fh, ensure_ascii=False, indent=2)
    except Exception as exc:  # noqa: BLE001
        logger.warning("规则持久化失败（已保留内存态）：%s", exc)
    return {"ok": True, "presetId": req.presetId}


@router.get("/api/leaderboard")
def api_get_leaderboard(
    stage: str,
    jobType: str = "all",
    subjective: Optional[str] = None,
) -> dict:
    """
    双 Leaderboard（T7）：基于 _STAGE_STORE 中 StageScore 生成 DualLeaderboard。
    - 客观榜：按 objectiveScore 降序。
    - 主观榜：默认序=客观序；若传 subjective（JSON 数组，agentId 拖拽序）则按之重排。
    - divergences：dragRank != objectiveRank 自动派生。
    无数据时回退 mock 条目，保证端点可用。
    """
    entries = []
    store = _STAGE_STORE.get(stage, {})
    if jobType != "all":
        store = {jobType: store.get(jobType, {})}
    for jt, agents in store.items():
        for aid, ss in agents.items():
            entries.append((aid, jt, ss))
    if not entries:
        entries = _mock_leaderboard_entries(stage, jobType)

    # 客观榜（按 objectiveScore 降序）
    obj_sorted = sorted(entries, key=lambda e: -float(e[2].get("objectiveScore", 0)))
    objective: List[LeaderboardEntry] = []
    for rank, (aid, jt, ss) in enumerate(obj_sorted, 1):
        objective.append(LeaderboardEntry(
            agentId=aid, name=aid, jobType=jt,
            objectiveScore=float(ss.get("objectiveScore", 0)),
            rank=rank,
            tier="MVP" if rank == 1 else ("BOTTOM" if rank == len(obj_sorted) else "NORMAL"),
        ))

    # 主观榜（默认=客观序；可选按 subjective 数组重排）
    sub_order = list(obj_sorted)
    if subjective:
        try:
            order = json.loads(subjective)
            by_id = {e[0]: e for e in entries}
            reordered = [by_id[a] for a in order if a in by_id]
            for e in entries:
                if e[0] not in order:
                    reordered.append(e)
            sub_order = reordered
        except Exception:  # noqa: BLE001
            pass

    subjective_entries: List[SubjectiveRankEntry] = []
    for rank, (aid, jt, ss) in enumerate(sub_order, 1):
        obj_rank = next((o.rank for o in objective if o.agentId == aid), rank)
        subjective_entries.append(SubjectiveRankEntry(
            agentId=aid, name=aid, jobType=jt,
            subjectiveScore=float(ss.get("subjectiveScore", 0)),
            objectiveRank=obj_rank, dragRank=rank,
        ))

    divergences: List[RankDivergence] = []
    for se in subjective_entries:
        if se.objectiveRank != se.dragRank:
            divergences.append(RankDivergence(
                agentId=se.agentId,
                objectiveRank=se.objectiveRank,
                dragRank=se.dragRank,
                delta=se.dragRank - se.objectiveRank,
            ))

    lb = DualLeaderboard(
        stage=stage, jobType=jobType,
        objective=objective, subjective=subjective_entries,
        divergences=divergences, updatedAt=datetime_now_iso(),
    )
    return lb.model_dump(mode="json")


@router.post("/api/preference")
def api_post_preference(req: PreferenceFeedbackRequest) -> dict:
    """
    偏好回灌（T8）：接收累计 PreferenceSignal 列表 + 当前 UserPreference.weight，
    聚合 → dimLift → apply_to_user_preference → 返回新 weight（Σ=1）。
    R1 门控：N<3 时返回原 weight 并标记 pending。
    """
    profile: PreferenceProfile = aggregate_preference(req.signals)
    N = len(req.signals)
    base_weight = req.currentWeight or dict(WeightVector().model_dump())
    new_weight = apply_to_user_preference(base_weight, profile.dimLift, alpha=0.15, N=N)
    applied = N >= 3
    return {
        "ownerId": req.ownerId,
        "weight": new_weight,
        "dimLift": profile.dimLift,
        "N": N,
        "applied": applied,
        "pending": (not applied),
    }
