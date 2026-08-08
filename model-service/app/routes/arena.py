"""Arena 个性化对决端点（T02 / 契约 §1.3）。

- POST /api/arena/compare   需求 → 题面 → 逐 agent 跑题 → LLM 客观分 → ArenaMatch(pending)
- POST /api/arena/user-pick 用户选择 → 双轨 Elo 更新 → 回填

幂等与防滥用（本地版，设计 §2.5）：
1. 同一 match_id 只允许一次 pick；重复 pick 返回 409。
2. 同需求 + 同候选集存在 pending match 时 compare 返回已有 match_id（不重复跑题）。
3. none 不计 Elo；draw 双方 +0.5。
4. 同一 agent 每天最多参与 50 场对决（进程内计数）。

存储：ArenaMatch 存进程内缓存（本地版）；Elo rating 进程内（主观主榜 + 客观辅榜）。
"""
from __future__ import annotations

import logging
import threading
import uuid
from datetime import date, datetime, timezone
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException

from ..candidate_runner import CandidateRunError, run_candidate
from ..judge_backend import JudgeUnavailable
from ..schemas import (
    ArenaCandidateAnswer,
    ArenaCompareRequest,
    ArenaMatch,
    ArenaPickResult,
    ArenaUserPickRequest,
)
from ..scoring import arena_judge, arena_templates, elo
from ..scoring.registry import JOB_CRAFT_DIMS

logger = logging.getLogger("serve")

router = APIRouter()

# ======================================================================
# 进程内状态（本地版）
# ======================================================================
_lock = threading.Lock()
_MATCHES: Dict[str, ArenaMatch] = {}
#: agent_id -> rating（主观主榜）
_SUBJECTIVE_RATINGS: Dict[str, float] = {}
#: agent_id -> rating（客观辅榜）
_OBJECTIVE_RATINGS: Dict[str, float] = {}
#: agent_id -> (date_str, count) 每日参与对决计数
_DAILY_PARTICIPATION: Dict[str, tuple] = {}
DAILY_MATCH_LIMIT = 50

#: 候选跑题通道白名单（与 candidate_runner 支持的 channel 枚举对齐）。
#: 契约 §1.3：候选通道未知 → 404；通道合法但调用失败 → 502。
SUPPORTED_CHANNELS = {"text", "gateway"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> str:
    return date.today().isoformat()


def get_ratings() -> dict:
    """当前双轨 Elo 快照（供调试 / 测试）。"""
    return {
        "subjective": dict(_SUBJECTIVE_RATINGS),
        "objective": dict(_OBJECTIVE_RATINGS),
    }


def _candidate_set(match: ArenaMatch) -> str:
    """候选集指纹（幂等去重键）：排序后的 agent_id 列表。"""
    return "|".join(sorted(c.agent_id for c in match.candidates))


def _find_pending_match(requirement_text: str, candidate_ids: List[str]) -> Optional[ArenaMatch]:
    key = "|".join(sorted(candidate_ids))
    for match in _MATCHES.values():
        if (
            match.status == "pending"
            and match.requirement_text == requirement_text
            and _candidate_set(match) == key
        ):
            return match
    return None


def _bump_daily(agent_id: str) -> bool:
    """每日参与计数；超限返回 False（本地防滥用）。"""
    today = _today()
    entry = _DAILY_PARTICIPATION.get(agent_id)
    if entry is None or entry[0] != today:
        _DAILY_PARTICIPATION[agent_id] = (today, 1)
        return True
    if entry[1] >= DAILY_MATCH_LIMIT:
        return False
    _DAILY_PARTICIPATION[agent_id] = (today, entry[1] + 1)
    return True


# ======================================================================
# POST /api/arena/compare
# ======================================================================
@router.post("/api/arena/compare")
async def api_arena_compare(req: ArenaCompareRequest) -> dict:
    requirement = (req.requirement_text or "").strip()
    if not requirement:
        raise HTTPException(status_code=422, detail="需求文本不能为空")
    if req.job_type not in JOB_CRAFT_DIMS:
        raise HTTPException(status_code=422, detail=f"不支持的工种：{req.job_type}")
    if not req.candidates:
        raise HTTPException(status_code=422, detail="至少需要一个候选 agent")
    if len(req.candidates) < 2:
        raise HTTPException(status_code=422, detail="Arena 对决至少需要两个候选 agent")

    # 候选通道白名单（契约 §1.3：未知/不支持通道 → 404；通道合法但调用失败 → 502）
    for c in req.candidates:
        channel = (c.channel or "").strip().lower()
        if channel and channel not in SUPPORTED_CHANNELS:
            raise HTTPException(
                status_code=404, detail=f"候选通道未知/不支持：{channel}"
            )

    # 幂等：同需求 + 同候选集存在 pending → 返回已有 match
    with _lock:
        existing = _find_pending_match(requirement, [c.agent_id for c in req.candidates])
        if existing is not None:
            return existing.model_dump(by_alias=True)

    # 每日防滥用：任一 agent 超限则拒绝
    with _lock:
        for c in req.candidates:
            if not _bump_daily(c.agent_id):
                raise HTTPException(
                    status_code=409,
                    detail=f"agent {c.agent_id} 今日参与对决已达上限（{DAILY_MATCH_LIMIT} 场）",
                )

    task_prompt = arena_templates.build_task_prompt(requirement, req.job_type)

    answers: List[ArenaCandidateAnswer] = []
    try:
        for c in req.candidates:
            candidate_dict = c.model_dump(exclude_none=True)
            run = run_candidate(task_prompt, candidate_dict)
            judgement = arena_judge.judge_arena_answer(
                requirement, task_prompt, req.job_type, run.text
            )
            answers.append(
                ArenaCandidateAnswer(
                    agent_id=c.agent_id,
                    agent_name=c.agent_name,
                    answer_text=run.text,
                    channel=run.channel,
                    latency_ms=run.latency_ms,
                    judgement=judgement,
                    objective_total=float(judgement.get("objective_total", 0.0)),
                )
            )
    except CandidateRunError as exc:
        raise HTTPException(status_code=502, detail=f"跑题失败：{exc}") from exc
    except JudgeUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"judge 后端不可用：{exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    objective_leader: Optional[str] = None
    if answers:
        objective_leader = max(answers, key=lambda a: a.objective_total).agent_id

    match = ArenaMatch(
        match_id=f"am-{uuid.uuid4().hex[:12]}",
        context=req.context,
        interview_id=req.interview_id,
        requirement_text=requirement,
        task_prompt=task_prompt,
        job_type=req.job_type,
        candidates=answers,
        objective_leader=objective_leader,
        user_pick=None,
        status="pending",
        elo_delta={},
        created_at=_now_iso(),
        picked_at=None,
    )
    with _lock:
        _MATCHES[match.match_id] = match
    return match.model_dump(by_alias=True)


# ======================================================================
# POST /api/arena/user-pick
# ======================================================================
@router.post("/api/arena/user-pick")
async def api_arena_user_pick(req: ArenaUserPickRequest) -> dict:
    with _lock:
        match = _MATCHES.get(req.match_id)
    if match is None:
        raise HTTPException(status_code=404, detail=f"未知 match_id：{req.match_id}")

    if match.status != "pending":
        raise HTTPException(status_code=409, detail="该对决已做出选择，不能重复 pick")

    pick = (req.pick or "").strip()
    candidate_ids = [c.agent_id for c in match.candidates]
    if pick not in candidate_ids and pick not in ("draw", "none"):
        raise HTTPException(status_code=422, detail=f"非法 pick 值：{pick}")

    # 双轨 Elo（A = 第一个候选，B = 第二个候选；超过两人的对决按 A vs B 处理）
    a_id = candidate_ids[0]
    b_id = candidate_ids[1] if len(candidate_ids) > 1 else candidate_ids[0]
    r_a = _SUBJECTIVE_RATINGS.get(a_id, elo.INITIAL_RATING)
    r_b = _SUBJECTIVE_RATINGS.get(b_id, elo.INITIAL_RATING)
    o_a = _OBJECTIVE_RATINGS.get(a_id, elo.INITIAL_RATING)
    o_b = _OBJECTIVE_RATINGS.get(b_id, elo.INITIAL_RATING)

    elo_delta: Dict[str, float] = {}
    winner: Optional[str] = elo.resolve_winner(pick, dict.fromkeys(candidate_ids))

    if pick != "none":
        # 主观轨（k=16，用户驱动）
        actual_a = elo.subjective_actual(pick, a_id, b_id)
        if actual_a is not None:
            k_sub = elo.apply_user_weight(elo.SUBJECTIVE_K)
            new_a, new_b = elo.update_pair(r_a, r_b, actual_a, k_sub)
            elo_delta[a_id] = round(new_a - r_a, 2)
            if b_id != a_id:
                elo_delta[b_id] = round(new_b - r_b, 2)
            _SUBJECTIVE_RATINGS[a_id] = new_a
            _SUBJECTIVE_RATINGS[b_id] = new_b

        # 客观轨（k=8，LLM 分差归一化）
        obj_a = match.candidates[0].objective_total
        obj_b = match.candidates[1].objective_total if len(match.candidates) > 1 else obj_a
        actual_obj_a = elo.objective_actual(obj_a, obj_b)
        k_obj = elo.apply_user_weight(elo.OBJECTIVE_K)
        new_oa, new_ob = elo.update_pair(o_a, o_b, actual_obj_a, k_obj)
        _OBJECTIVE_RATINGS[a_id] = new_oa
        _OBJECTIVE_RATINGS[b_id] = new_ob

    match.user_pick = pick
    match.status = "picked" if pick != "none" else "abandoned"
    match.elo_delta = elo_delta
    match.picked_at = _now_iso()

    result = ArenaPickResult(
        match_id=match.match_id,
        status=match.status,
        user_pick=pick,
        winner=winner,
        elo_delta=elo_delta,
        subjective_ratings=dict(_SUBJECTIVE_RATINGS),
        objective_ratings=dict(_OBJECTIVE_RATINGS),
    )
    return result.model_dump(by_alias=True)
