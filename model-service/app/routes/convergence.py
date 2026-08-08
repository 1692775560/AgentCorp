"""Layer3 收敛域：/api/convergence/* + 进程内引擎状态与持久化（纯搬运自原 serve.py）。

Layer3 收敛说明（MVP）：/api/evaluate-run 携带 convergence 字段时，
服务端用「确定性投影 + 每轮 3 个合成候选」构造收敛轨迹——这是 MVP
投影演示数据，**不是**实测的模型 belief/候选。为诚实标注，SSE 的
convergence_update / convergence_score 事件 payload 均携带
"source": "projected" 与 "synthetic": true，前端可据此区分真假。
"""
from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, AliasGenerator
from pydantic.alias_generators import to_camel

# Layer3 收敛（T13/T14/T15/T16）：仅追加，不破坏既有端点。
from ..scoring import (
    ConvergenceEngine,
    ConvergenceTrace,
    TurnState,
    CandidateEmbedding,
    HumanAnchor,
    ConvergenceConfig,
    encode_summary,
)
from ..schemas import JudgeRunRequest
from ._common import datetime_now_iso

logger = logging.getLogger("serve")

router = APIRouter()

# ======================================================================
# Layer3 收敛（T16）：进程内 store + 可选 JSON 落盘（零新依赖）
# ======================================================================
_ENGINE = ConvergenceEngine()  # 端点共用引擎（含锚点库）
_TRACE_STORE: dict[str, ConvergenceTrace] = {}
_TRACE_LOCK = threading.Lock()
_CONV_STORE_PATH = os.getenv("CONVERGENCE_STORE_PATH", "convergence-store.json")

# 并发模型（_TRACE_LOCK 的保护范围）：
# - FastAPI sync 端点（/api/convergence/*）跑在 anyio 线程池，SSE 端点
#   （/api/evaluate-run）协程内也会写 store，二者可并发 → 所有
#   _TRACE_STORE 读写必须持 _TRACE_LOCK。
# - _persist_convergence 全程持锁：快照迭代与文件写原子（进程内），
#   避免多线程同时 json.dump 同一文件产生交错/截断的坏文件。临界区仅
#   dict 操作 + 一次小文件写，对事件循环阻塞可忽略。
# - 多 uvicorn worker 是**多进程**：内存 store 不共享，落盘文件为
#   进程间最后写胜出；跨进程一致性不在 MVP 范围（需共享存储或单
#   worker 部署约束）。


def _persist_convergence() -> bool:
    """可选落盘到 JSON（无 electron 后端时回退为文件）。

    返回是否落盘成功；失败时 logger.exception 带堆栈，由调用方决定
    如何在响应 / SSE 事件中显式标记（persisted: false），不再静默。
    """
    try:
        with _TRACE_LOCK:
            payload = {
                "traces": [t.model_dump(mode="json") for t in _TRACE_STORE.values()],
                "anchors": [a.model_dump(mode="json") for a in _ENGINE.list_anchors()],
            }
            with open(_CONV_STORE_PATH, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False)
        return True
    except Exception:  # noqa: BLE001
        logger.exception("收敛落盘失败：%s", _CONV_STORE_PATH)
        return False


class ConvergenceScoreRequest(BaseModel):
    """/api/convergence/score 入参：runId 或完整 trace 二选一。"""

    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    run_id: Optional[str] = None
    trace: Optional[ConvergenceTrace] = None


def _build_convergence_trace_from_run(
    req: JudgeRunRequest, conv_cfg: dict
) -> "tuple[ConvergenceTrace, ConvergenceEngine]":
    """
    由 /api/evaluate-run 的真实输入派生收敛轨迹（MVP 最小化记录）：
    用确定性投影把任务描述编码为各轮 belief embedding + 3 个合成候选。

    注意：这是 **MVP 投影演示数据**（projected/synthetic），并非实测的
    模型 belief 与候选集；SSE 事件 payload 携带 source="projected" /
    synthetic=true 标注，前端可据此区分。锚点后续由
    /api/convergence/anchor 显式置顶。
    """
    k = int(conv_cfg.get("k", 3) or 3)
    cfg = ConvergenceConfig(k=k)
    eng = ConvergenceEngine(config=cfg)
    run_id = f"conv-{req.agent_id}-{uuid.uuid4().hex[:8]}"
    base = (req.task.title + " " + req.task.description + " " + (req.agent_name or req.agent_id))
    turns: list[TurnState] = []
    for t in range(k + 1):  # turn 0..K
        belief = encode_summary(f"{base} turn {t}")
        cands = [
            CandidateEmbedding(
                candidateId=f"{run_id}-t{t}-c{ci}",
                turn=t,
                summaryText=f"{base} candidate {ci} turn {t}",
                embedding=encode_summary(f"{base} candidate {ci} turn {t} salt{ci}"),
                jobType="code",
            )
            for ci in range(3)
        ]
        turns.append(TurnState(turn=t, candidates=cands, beliefEmbedding=belief))
    trace = ConvergenceTrace(
        runId=run_id,
        agentId=req.agent_id,
        jobType="code",
        k=k,
        turns=turns,
        createdBy="auto-evaluate-run",
        ts=datetime_now_iso(),
    )
    return trace, eng


# ======================================================================
# Layer3 收敛端点（T16）：/api/convergence/{trace,score,anchor}
# 不破坏既有 /api/evaluate* 端点。
# ======================================================================
@router.post("/api/convergence/trace")
def api_convergence_trace(req: ConvergenceTrace) -> dict:
    """记录一次收敛轨迹，返回 runId + persisted（落盘是否成功）。"""
    with _TRACE_LOCK:
        _TRACE_STORE[req.run_id] = req
    persisted = _persist_convergence()
    return {"run_id": req.run_id, "persisted": persisted}


@router.post("/api/convergence/score")
def api_convergence_score(req: ConvergenceScoreRequest) -> dict:
    """由 runId 或完整 trace 计算 convergence_score。"""
    trace = req.trace
    if trace is None:
        with _TRACE_LOCK:
            trace = _TRACE_STORE.get(req.run_id or "")
    if trace is None:
        raise HTTPException(
            status_code=422,
            detail="需要 runId（已记录的轨迹）或 trace（完整轨迹）",
        )
    score = _ENGINE.compute_convergence_score(trace)
    return score.model_dump(mode="json")


@router.get("/api/convergence/anchor")
def api_get_anchor(ownerId: Optional[str] = None) -> list:
    """读取人类锚点（可按 ownerId 过滤）。"""
    return [a.model_dump(mode="json") for a in _ENGINE.list_anchors(ownerId)]


@router.post("/api/convergence/anchor")
def api_post_anchor(req: HumanAnchor) -> dict:
    """设置/置顶锚点（显式 pin 源）。返回 ok + anchorId + persisted。

    A1：此前直接写 _ENGINE._anchors 而绕过 set_anchor，导致
    trace.anchor_candidate_id 永不回填 —— 经 HTTP 设的锚点对评分毫无影响
    （CQ 恒 0、R/St 恒走未锚定兜底）。现改为：轨迹已记录时走 set_anchor
    回填，未记录时才退化为仅存锚点。
    """
    with _TRACE_LOCK:
        trace = next(
            (t for t in _TRACE_STORE.values()
             if any(c.candidate_id == req.candidate_id
                    for turn in t.turns for c in turn.candidates)),
            None,
        )
    anchored_run_id: Optional[str] = None
    if trace is not None:
        _ENGINE.set_anchor(trace, req.candidate_id, req.source)
        anchored_run_id = trace.run_id
    else:
        _ENGINE._anchors[req.anchor_id] = req
    persisted = _persist_convergence()
    return {
        "ok": True,
        "anchor_id": req.anchor_id,
        "anchored_run_id": anchored_run_id,
        "persisted": persisted,
    }
