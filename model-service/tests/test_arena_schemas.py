"""
model-service/tests/test_arena_schemas.py

Arena / Likes / Favorites 契约模型单测。

覆盖：
1. ArenaCompareRequest 的 camelCase/snake_case 双向兼容（alias_generator 先例）
2. ArenaMatch / ArenaCandidateAnswer 字段与默认值
3. LikeRecord / FavoriteVoteRequest / FavoriteRanking 序列化契约
4. 非法上下文/状态枚举约束

运行：python -m pytest tests/test_arena_schemas.py -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app.schemas import (  # noqa: E402
    ArenaCandidateAnswer,
    ArenaCandidateRef,
    ArenaCompareRequest,
    ArenaMatch,
    ArenaPickResult,
    ArenaUserPickRequest,
    FavoriteRanking,
    FavoriteRankingEntry,
    FavoriteVoteRequest,
    FavoriteVoteResult,
    LikeRecord,
)


# ----------------------------------------------------------------------
# 1) ArenaCompareRequest 兼容两种命名
# ----------------------------------------------------------------------
def test_arena_compare_request_accepts_camel_case():
    req = ArenaCompareRequest(
        requirementText="要一个稳定的后端 agent",
        jobType="code",
        candidates=[
            {"agentId": "a1", "agentName": "甲", "channel": "text", "answer": "我会写代码"}
        ],
    )
    assert req.requirement_text == "要一个稳定的后端 agent"
    assert req.job_type == "code"
    assert req.candidates[0].agent_id == "a1"
    assert req.candidates[0].answer == "我会写代码"
    assert req.context == "arena"


def test_arena_compare_request_accepts_snake_case():
    req = ArenaCompareRequest(
        requirement_text="x",
        job_type="text",
        candidates=[{"agent_id": "a2"}],
        context="interview",
        interview_id="itv-1",
    )
    assert req.candidates[0].agent_id == "a2"
    assert req.context == "interview"
    assert req.interview_id == "itv-1"


def test_arena_compare_request_serializes_camel_case():
    req = ArenaCompareRequest(requirement_text="x", job_type="code", candidates=[])
    dumped = req.model_dump(by_alias=True)
    assert dumped["requirementText"] == "x"
    assert dumped["jobType"] == "code"
    assert "requirement_text" not in dumped


def test_arena_compare_request_rejects_empty_requirement_fields():
    with pytest.raises(ValidationError):
        ArenaCompareRequest(job_type="code", candidates=[])


def test_arena_compare_request_rejects_bad_context():
    with pytest.raises(ValidationError):
        ArenaCompareRequest(
            requirement_text="x",
            job_type="code",
            candidates=[],
            context="not-a-context",
        )


# ----------------------------------------------------------------------
# 2) ArenaMatch / ArenaCandidateAnswer
# ----------------------------------------------------------------------
def test_arena_match_defaults():
    match = ArenaMatch(match_id="m1", requirement_text="r", task_prompt="t", job_type="code")
    assert match.context == "arena"
    assert match.interview_id is None
    assert match.candidates == []
    assert match.objective_leader is None
    assert match.user_pick is None
    assert match.status == "pending"
    assert match.elo_delta == {}
    assert match.created_at == ""
    assert match.picked_at is None


def test_arena_match_serializes_camel_case():
    match = ArenaMatch(
        match_id="m1",
        context="interview",
        interview_id="itv-1",
        requirement_text="r",
        task_prompt="t",
        job_type="code",
    )
    dumped = match.model_dump(by_alias=True)
    assert dumped["matchId"] == "m1"
    assert dumped["interviewId"] == "itv-1"
    assert dumped["requirementText"] == "r"
    assert dumped["taskPrompt"] == "t"
    assert dumped["jobType"] == "code"


def test_arena_candidate_answer_roundtrip():
    ans = ArenaCandidateAnswer(
        agent_id="a1",
        agent_name="甲",
        answer_text="答案",
        channel="text",
        latency_ms=12.5,
        judgement={"dims": {"code_runnability": 4.0}, "fit": 3.5},
        objective_total=3.8,
    )
    dumped = ans.model_dump(by_alias=True)
    assert dumped["agentId"] == "a1"
    assert dumped["answerText"] == "答案"
    assert dumped["objectiveTotal"] == 3.8
    assert dumped["judgement"]["fit"] == 3.5


def test_arena_pick_result_fields():
    result = ArenaPickResult(
        match_id="m1",
        user_pick="a1",
        winner="a1",
        elo_delta={"a1": 12.0, "a2": -12.0},
        subjective_ratings={"a1": 1012.0, "a2": 988.0},
        objective_ratings={"a1": 1008.0, "a2": 992.0},
    )
    dumped = result.model_dump(by_alias=True)
    assert dumped["subjectiveRatings"]["a1"] == 1012.0
    assert dumped["objectiveRatings"]["a2"] == 992.0
    assert dumped["eloDelta"]["a1"] == 12.0


# ----------------------------------------------------------------------
# 3) Like / Favorite 契约
# ----------------------------------------------------------------------
def test_like_record_defaults():
    rec = LikeRecord(agent_id="a1")
    assert rec.count == 0
    assert rec.liked_by_me is False
    assert rec.users == []
    dumped = rec.model_dump(by_alias=True)
    assert dumped["likedByMe"] is False
    assert "liked_by_me" not in dumped


def test_favorite_vote_request_camel_case():
    req = FavoriteVoteRequest(
        agentId="a1",
        jobType="code",
        stage="arena",
        sourceId="m1",
        votedBy="owner",
    )
    assert req.agent_id == "a1"
    assert req.source_id == "m1"
    assert req.voted_by == "owner"
    dumped = req.model_dump(by_alias=True)
    assert dumped["sourceId"] == "m1"


def test_favorite_vote_request_rejects_bad_stage():
    with pytest.raises(ValidationError):
        FavoriteVoteRequest(agent_id="a1", job_type="code", stage="hack")


def test_favorite_vote_result_camel_case():
    result = FavoriteVoteResult(agent_id="a1", job_type="code", count=3, voted=True)
    dumped = result.model_dump(by_alias=True)
    assert dumped["agentId"] == "a1"
    assert dumped["jobType"] == "code"


def test_favorite_ranking_sort_preserved():
    ranking = FavoriteRanking(
        job_type="code",
        ranking=[
            FavoriteRankingEntry(agent_id="a2", count=5, voters=["u1"]),
            FavoriteRankingEntry(agent_id="a1", count=9, voters=[]),
        ],
    )
    dumped = ranking.model_dump(by_alias=True)
    assert dumped["ranking"][0]["agentId"] == "a2"  # 保持传入顺序，排序由调用方保证
    assert dumped["ranking"][0]["voters"] == ["u1"]
