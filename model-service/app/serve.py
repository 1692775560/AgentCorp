"""
model-service/app/serve.py
FastAPI 入口（架构 §4.2 / 类图 ServeApp）。

端点：
  GET  /api/samples    → CandidateProfile[]（固定样本清单，含媒体 URL）
  POST /api/evaluate   → SSE 事件流（radar_update/narration/audio/verdict/done）
  POST /api/upload     → multipart → 新 CandidateProfile（P1 上传模式）

设计：前后端彻底解耦，契约见 schemas.py 与前端 src/types/index.ts。
无 NPU 时若 MOCK=true 仍可运行；否则 /api/evaluate 返回 503 明确错误。
"""
from __future__ import annotations

import json
import logging
import os
import asyncio
import uuid
from typing import List, Optional

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from .config import settings
from .evaluator import evaluate as run_evaluate
from .evaluator import evaluate_run as run_evaluate_run
from .model_loader import get_model
from .schemas import (
    CandidateProfile,
    EvaluationRequest,
    JudgeRunRequest,
    PersonaText,
    to_event_dict,
)
# Layer3 收敛（T13/T14/T15/T16）：仅追加，不破坏既有端点。
from .scoring import (
    ConvergenceEngine,
    ConvergenceTrace,
    TurnState,
    CandidateEmbedding,
    HumanAnchor,
    ConvergenceScore,
    ConvergenceConfig,
    encode_summary,
)
# 批次2（T4–T9）：仅追加，不破坏既有端点（架构 §2.1 / 实现清单）。
from .scoring.stage_scorer import build_stage_score
from .scoring.preference import aggregate_preference, apply_to_user_preference
from .scoring.task_sets import get_task_set
from .scoring.rules_engine import load_rules, _PRESETS_DIR as _SCORING_PRESETS_DIR
from .schemas import (
    StageScoreRequest,
    LeaderboardEntry,
    SubjectiveRankEntry,
    RankDivergence,
    DualLeaderboard,
    PreferenceSignal,
    PreferenceProfile,
    PreferenceFeedbackRequest,
    ScoringRulesLoad,
    WeightVector,
)
from pydantic import BaseModel, Field, ConfigDict, AliasGenerator
from pydantic.alias_generators import to_camel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("serve")

# ======================================================================
# Layer3 收敛（T16）：进程内 store + 可选 JSON 落盘（零新依赖）
# ======================================================================
_ENGINE = ConvergenceEngine()  # 端点共用引擎（含锚点库）
_TRACE_STORE: dict[str, ConvergenceTrace] = {}
_CONV_STORE_PATH = os.getenv("CONVERGENCE_STORE_PATH", "convergence-store.json")


def _persist_convergence() -> None:
    """可选落盘到 JSON（无 electron 后端时回退为文件）。失败静默。"""
    try:
        payload = {
            "traces": [t.model_dump(mode="json") for t in _TRACE_STORE.values()],
            "anchors": [a.model_dump(mode="json") for a in _ENGINE.list_anchors()],
        }
        with open(_CONV_STORE_PATH, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001
        logger.warning("收敛落盘失败（可选，已忽略）：%s", exc)


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
    锚点后续由 /api/convergence/anchor 显式置顶。
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


def datetime_now_iso() -> str:
    import datetime as _dt

    return _dt.datetime.now(_dt.timezone.utc).isoformat()


app = FastAPI(title="AgentCorp MiniCPM-o Evaluator", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load_samples() -> List[CandidateProfile]:
    """读取 samples 目录下各候选的 profile.json。"""
    samples: List[CandidateProfile] = []
    base = settings.samples_dir
    if not os.path.isdir(base):
        logger.warning("样本目录不存在：%s", base)
        return samples
    for name in sorted(os.listdir(base)):
        prof_path = os.path.join(base, name, "profile.json")
        if os.path.isfile(prof_path):
            try:
                with open(prof_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                samples.append(CandidateProfile(**data))
            except Exception as exc:  # noqa: BLE001
                logger.error("读取 %s 失败：%s", prof_path, exc)
    return samples


@app.get("/api/samples")
def get_samples() -> List[CandidateProfile]:
    return _load_samples()


@app.post("/api/evaluate")
async def api_evaluate(req: EvaluationRequest):
    model = get_model()
    if not settings.mock and not model.available:
        raise HTTPException(
            status_code=503,
            detail="模型不可用：无 NPU 或未配置权重。请部署到昇腾环境，或设置 MOCK=true。",
        )

    mode = "mock" if settings.mock else "auto"

    async def event_gen():
        async for ev in run_evaluate(req, mode=mode):
            yield {
                "event": ev["type"],
                "data": json.dumps(to_event_dict(_wrap(ev)), ensure_ascii=False),
            }

    return EventSourceResponse(event_gen())


@app.post("/api/evaluate-run")
async def api_evaluate_run(req: JudgeRunRequest):
    """
    运行期裁判端点（T07）：接收 JudgeRunInput（transcript + usage + task），
    产出与 /api/evaluate 同构的 SSE 事件流（radar_update ×6 + verdict + done）。
    无 NPU / MOCK=true 时走 Mock 派生；模型可用时走真实推理。
    """
    model = get_model()
    if not settings.mock and not model.available:
        raise HTTPException(
            status_code=503,
            detail="模型不可用：无 NPU 或未配置权重。请部署到昇腾环境，或设置 MOCK=true。",
        )

    mode = "mock" if settings.mock else "auto"
    conv_cfg = req.convergence  # Layer3：可选收敛记录（None 则仅静默记录/不扩展）

    async def event_gen():
        eng = None
        trace = None
        if conv_cfg:  # 命中收敛字段 → 记录轨迹并发 convergence 事件
            trace, eng = _build_convergence_trace_from_run(req, conv_cfg)
            _TRACE_STORE[trace.run_id] = trace
            # 逐轮发 convergence_update（携带 TurnState）
            for turn in trace.turns:
                yield {
                    "event": "convergence_update",
                    "data": json.dumps(
                        turn.model_dump(mode="json"), ensure_ascii=False
                    ),
                }
        # T9：可选 Task-Set 调度（向后兼容，缺省 usage_efficiency；不影响既有流）
        task_set_id = req.task_set_id or "usage_efficiency"
        try:
            ts = get_task_set(task_set_id)
            if ts is not None:
                result = ts.run(req)
                yield {
                    "event": "task_run",
                    "data": json.dumps(result.model_dump(mode="json"), ensure_ascii=False),
                }
        except Exception as exc:  # noqa: BLE001
            logger.warning("TaskSet %s 运行失败（不影响主裁判流）：%s", task_set_id, exc)
        async for ev in run_evaluate_run(req, mode=mode):
            yield {
                "event": ev["type"],
                "data": json.dumps(to_event_dict(_wrap(ev)), ensure_ascii=False),
            }
        if eng and trace:
            score = eng.compute_convergence_score(trace)
            yield {
                "event": "convergence_score",
                "data": json.dumps(
                    score.model_dump(mode="json"), ensure_ascii=False
                ),
            }
            _persist_convergence()

    return EventSourceResponse(event_gen())


def _wrap(ev: dict):
    """将事件 dict 包装为对应 Pydantic 模型以便序列化（枚举转字符串）。"""
    from . import schemas as S

    mapping = {
        "radar_update": S.RadarUpdateEvent,
        "narration": S.NarrationEvent,
        "audio": S.AudioEvent,
        "verdict": S.VerdictEvent,
        "done": S.DoneEvent,
    }
    cls = mapping.get(ev["type"])
    return cls(**ev) if cls else ev


@app.post("/api/upload")
async def api_upload(
    name: str = Form(...),
    declared_tags: str = Form(""),
    declared_budget: float = Form(200.0),
    persona_text: str = Form(""),
    video: UploadFile = File(None),
    voice: UploadFile = File(None),
    code: UploadFile = File(None),
) -> CandidateProfile:
    """
    P1 上传模式：接收多模态附件，落盘到 upload_dir，返回新 CandidateProfile。
    媒体以服务端 URL 提供（前端据此渲染）。
    """
    os.makedirs(settings.upload_dir, exist_ok=True)
    cid = f"upload-{uuid.uuid4().hex[:8]}"
    cdir = os.path.join(settings.upload_dir, cid)
    os.makedirs(cdir, exist_ok=True)

    def _save(file: UploadFile | None, fname: str) -> str:
        if not file:
            return ""
        path = os.path.join(cdir, fname)
        with open(path, "wb") as f:
            f.write(file.file.read())
        return f"/uploads/{cid}/{fname}"

    video_url = _save(video, "video.mp4")
    voice_url = _save(voice, "voice.wav")
    code_url = _save(code, "code.zip")

    tags = [t.strip() for t in declared_tags.split(",") if t.strip()]
    profile = CandidateProfile(
        id=cid,
        name=name or cid,
        declared_tags=tags,
        declared_budget=declared_budget,
        persona_text=PersonaText(content=persona_text),
        video_demo={"type": "video/mp4", "url": video_url},
        voice_intro={"type": "audio/wav", "url": voice_url},
        artwork=[],
        code_repo={"type": "application/zip", "url": code_url, "lang": "unknown"},
    )
    return profile


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
@app.post("/api/evaluate-stage")
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


@app.get("/api/rules")
def api_get_rules(preset: str = "default") -> dict:
    """读取规则预设（T5）：优先内存覆盖，否则从 presets/<preset>.json 加载。"""
    if preset in _RULES_OVERRIDES:
        return _RULES_OVERRIDES[preset]
    return load_rules(preset)


@app.put("/api/rules")
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


@app.get("/api/leaderboard")
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


@app.post("/api/preference")
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


# ======================================================================
# Layer3 收敛端点（T16）：/api/convergence/{trace,score,anchor}
# 不破坏既有 /api/evaluate* 端点。
# ======================================================================
@app.post("/api/convergence/trace")
def api_convergence_trace(req: ConvergenceTrace) -> dict:
    """记录一次收敛轨迹，返回 runId。"""
    _TRACE_STORE[req.run_id] = req
    _persist_convergence()
    return {"run_id": req.run_id}


@app.post("/api/convergence/score")
def api_convergence_score(req: ConvergenceScoreRequest) -> dict:
    """由 runId 或完整 trace 计算 convergence_score。"""
    trace = req.trace or _TRACE_STORE.get(req.run_id or "")
    if trace is None:
        raise HTTPException(
            status_code=422,
            detail="需要 runId（已记录的轨迹）或 trace（完整轨迹）",
        )
    score = _ENGINE.compute_convergence_score(trace)
    return score.model_dump(mode="json")


@app.get("/api/convergence/anchor")
def api_get_anchor(ownerId: Optional[str] = None) -> list:
    """读取人类锚点（可按 ownerId 过滤）。"""
    return [a.model_dump(mode="json") for a in _ENGINE.list_anchors(ownerId)]


@app.post("/api/convergence/anchor")
def api_post_anchor(req: HumanAnchor) -> dict:
    """设置/置顶锚点（显式 pin 源）。返回 ok + anchorId。"""
    _ENGINE._anchors[req.anchor_id] = req
    _persist_convergence()
    return {"ok": True, "anchor_id": req.anchor_id}


@app.get("/health")
def health() -> dict:
    model = get_model()
    return {
        "status": "ok",
        "mock": settings.mock,
        "model_available": model.available,
    }


if __name__ == "__main__":
    uvicorn.run(app, host=settings.host, port=settings.port)
