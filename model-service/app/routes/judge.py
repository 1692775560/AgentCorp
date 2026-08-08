"""HR 面试 S2 评测端点（LLM-as-judge 试做题 + 对话评分）。

- GET  /api/craft-tasks   公开题库（**不含参考答案**，防刷题）
- POST /api/craft-judge   一道试做题评分：answer（A3 直传）或 candidate 引用（A2 跑题）
- POST /api/chat-judge    面试对话整段评分（C）：judge 可用 source=judge，否则降级 source=degraded

与 routes/evaluate.py 的职责边界：evaluate.py 负责跨模态评估与运行期裁判的 SSE 流；
本模块负责 HR 面试的「客观试做题」与「对话证据评分」两个新入口，全部返回 JSON。
"""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger("serve")

router = APIRouter()


class CraftJudgeRequest(BaseModel):
    """试做题评分入参：answer（A3 直传）或 candidate 引用（A2 跑题后评分）。"""

    task_id: str
    answer: Optional[str] = None
    candidate: Optional[dict] = None


class ChatJudgeRequest(BaseModel):
    """对话逐轮/整段评分入参（C：live 面试证据 → 模型评测，降级返回 source=degraded）。"""

    agent_id: str
    agent_name: str = ""
    transcript: str = ""
    usage: List[dict] = Field(default_factory=list)
    task: Optional[dict] = None


@router.get("/api/craft-tasks")
def api_craft_tasks() -> list:
    """公开题库列表。安全边界：**不返回参考答案**（防刷题），只给题面/rubric/探针。"""
    from ..scoring.craft_tasks import all_task_ids, get_task

    out = []
    for tid in all_task_ids():
        task = get_task(tid)
        if task is None:
            continue
        out.append(
            {
                "id": task.id,
                "job_type": task.job_type,
                "title": task.title,
                "prompt": task.prompt,
                "target_dims": task.target_dims,
                "checkpoints": task.checkpoints,
            }
        )
    return out


@router.post("/api/craft-judge")
async def api_craft_judge(req: CraftJudgeRequest) -> dict:
    """对一道试做题评分：候选答案（A3）或 candidate 引用跑题后评分（A2）。"""
    from ..candidate_runner import CandidateRunError, run_candidate
    from ..judge_backend import JudgeUnavailable
    from ..scoring.craft_judge import judge_craft_task
    from ..scoring.craft_tasks import get_task

    task = get_task(req.task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"未知题目 id：{req.task_id}")

    if req.answer is not None:
        answer = req.answer
    elif req.candidate:
        try:
            answer = run_candidate(task.prompt, req.candidate).text
        except CandidateRunError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    else:
        raise HTTPException(status_code=422, detail="需提供 answer 或 candidate 引用")

    try:
        judgement = judge_craft_task(req.task_id, answer)
    except JudgeUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail=f"craft 评测后端不可用：{exc}",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {
        "task_id": judgement.task_id,
        "job_type": judgement.job_type,
        "dims": judgement.dims,
        "unscored_dims": judgement.unscored_dims,
        "checkpoints": [
            {"checkpoint": c.checkpoint, "hit": c.hit, "quote": c.quote}
            for c in judgement.checkpoints
        ],
        "padding_detected": judgement.padding_detected,
        "padding_note": judgement.padding_note,
        "confidence": judgement.confidence,
        "reference_used": judgement.reference_used,
        "ttft_ms": judgement.ttft_ms,
        "latency_ms": judgement.latency_ms,
        "backend": judgement.backend,
    }


@router.post("/api/chat-judge")
async def api_chat_judge(req: ChatJudgeRequest) -> dict:
    """
    对话逐轮/整段评分（C）。

    judge 可用 → source=judge（模型六维 + evidence）；
    judge 不可用 → source=degraded（transcript 弱信号派生，confidence=0.35），
    前端据此决定是否优先展示模型分，避免把启发式当真实评测。
    """
    from ..evaluator import (
        _build_run_prompt,
        _derive_run_radar,
        _run_radar_evidence,
        _verdict_from_radar,
        infer,
        judge_available,
        parse_output,
    )
    from ..judge_backend import JudgeUnavailable
    from ..schemas import JudgeRunRequest

    jreq = JudgeRunRequest(
        agent_id=req.agent_id,
        agent_name=req.agent_name,
        transcript=req.transcript,
        usage=req.usage,
    )

    def degraded() -> dict:
        radar = _derive_run_radar(jreq)
        return {
            "source": "degraded",
            "radar": radar.model_dump(),
            "verdict": _verdict_from_radar(radar).value,
            "confidence": 0.35,
            "evidence_trace": _run_radar_evidence(jreq),
        }

    if not judge_available():
        return degraded()

    messages = [{"role": "user", "content": _build_run_prompt(jreq)}]
    try:
        raw = infer({}, messages)
        parsed = parse_output(raw)
    except JudgeUnavailable:
        return degraded()

    radar = parsed["radar"]
    return {
        "source": "judge",
        "radar": radar.model_dump(),
        "verdict": parsed["verdict"].value,
        "confidence": parsed["confidence"],
        "evidence_trace": parsed["evidence_trace"],
    }
