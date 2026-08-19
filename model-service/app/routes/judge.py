"""HR 面试 S2 评测端点（LLM-as-judge 试做题 + 对话评分）。

- GET  /api/craft-tasks   公开题库（**不含参考答案**，防刷题）
- POST /api/craft-judge   一道试做题评分：answer（A3 直传）或 candidate 引用（A2 跑题）
                          code 工种会附带真实执行验证（sandbox），产出 verifiedEvidence
- POST /api/craft-verify  只跑沙盒不评分（调试/复核用：同一份答案的执行结果可独立复现）
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
    #: 是否对 code 工种执行真实沙盒验证（默认开；沙盒本身另有 SANDBOX_ENABLED 总开关）
    verify: bool = True


class CraftVerifyRequest(BaseModel):
    """只执行不评分：用于人工复核「这段代码到底能不能跑」。"""

    task_id: str = ""
    answer: str


class ChatJudgeRequest(BaseModel):
    """对话逐轮/整段评分入参（C：live 面试证据 → 模型评测，降级返回 source=degraded）。"""

    agent_id: str
    agent_name: str = ""
    transcript: str = ""
    usage: List[dict] = Field(default_factory=list)
    task: Optional[dict] = None
    #: ensemble 第几次采样。0 = 基准（温度 0，可复现）；>0 = 扰动采样
    #: （温度 JUDGE_ENSEMBLE_TEMPERATURE，模型按 JUDGE_MODELS 轮转）。
    #: 后端决定用哪个模型/温度，凭据与模型池不下发渲染层。
    variant: int = 0


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

    # —— 真实执行验证（只对 code 工种有意义）——
    # 与评分完全解耦：沙盒结果不喂给裁判、也不改裁判分数，
    # 只作为 verifiedEvidence 影响 stage_scorer 的 Q6 降权。
    # 这样「模型怎么看」与「机器怎么测」两条证据链互相独立，可交叉验证。
    sandbox_payload = None
    verified_evidence: dict = {}
    scan_payload = None
    if req.verify and task.job_type == "code":
        from ..sandbox import (
            run_python_answer,
            scan_python_answer,
            security_evidence_for,
            verified_evidence_for,
        )

        # 两条独立的机器证据链：执行验「能不能跑」，扫描验「有没有危险构造」。
        # 测试全绿的代码照样可以是 eval(user_input)，所以二者不可互相替代。
        sandbox_result = run_python_answer(answer)
        sandbox_payload = sandbox_result.to_dict()
        verified_evidence = verified_evidence_for(task.id, sandbox_result)

        scan_result = scan_python_answer(answer)
        scan_payload = scan_result.to_dict()
        verified_evidence.update(security_evidence_for(task.id, scan_result))

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
        # 机器可核验证据（可为空）。空 = 未验证，下游据此继续对 requiresReal 维降权。
        "verified_evidence": verified_evidence,
        "sandbox": sandbox_payload,
        "security_scan": scan_payload,
    }


@router.post("/api/craft-verify")
async def api_craft_verify(req: CraftVerifyRequest) -> dict:
    """
    只跑沙盒不评分。

    存在意义：评审现场要能独立复现「这段代码通过了几个用例」，
    而不必连带跑一次裁判推理（后者要花钱、要联网、且结果可能漂移）。
    """
    from ..sandbox import (
        run_python_answer,
        scan_python_answer,
        security_evidence_for,
        verified_evidence_for,
    )

    task_id = req.task_id or "adhoc"
    result = run_python_answer(req.answer)
    scan = scan_python_answer(req.answer)
    evidence = verified_evidence_for(task_id, result)
    evidence.update(security_evidence_for(task_id, scan))
    return {
        "sandbox": result.to_dict(),
        "security_scan": scan.to_dict(),
        "verified_evidence": evidence,
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
        judge_available,
        parse_output,
    )
    from ..judge_backend import JudgeUnavailable, get_backend, resolve_ensemble_run
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
    # ensemble 扰动：第 0 次用温度 0 的可复现基准，之后每次换温度（并在配置了
    # 跨家族模型池时换模型）。真实重复采样才让 pass^k / 离散度审计有统计意义。
    model, temperature = resolve_ensemble_run(req.variant)
    try:
        completion = get_backend().complete(messages, temperature=temperature, model=model)
        parsed = parse_output(completion.text)
    except JudgeUnavailable:
        return degraded()
    except Exception as exc:  # noqa: BLE001 —— 解析失败按降级处理，不 500
        logger.warning("chat-judge 解析失败，降级：%s", exc)
        return degraded()

    radar = parsed["radar"]
    return {
        "source": "judge",
        "radar": radar.model_dump(),
        "verdict": parsed["verdict"].value,
        "confidence": parsed["confidence"],
        "evidence_trace": parsed["evidence_trace"],
        # 采样透明化：这一票由哪个模型、在什么温度下给出，必须可追溯。
        # 否则「跨家族交叉验证」只是一句无法核对的声明。
        "judge_model": completion.model,
        "temperature": temperature,
        "variant": req.variant,
        "ttft_ms": completion.ttft_ms,
        "latency_ms": completion.latency_ms,
    }
