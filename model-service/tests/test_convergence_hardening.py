"""
model-service/tests/test_convergence_hardening.py
08-07 收敛引擎加固回归：并发保护 / 持久化显式失败 / 合成轨迹诚实标注。

运行（在 model-service 目录下）：
    MOCK=true python -m pytest tests/test_convergence_hardening.py -q
"""
from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
import threading

import pytest

# 让测试能 import app 包（命名空间包，无 __init__.py）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# MOCK=true 保证 /api/evaluate-run 走 Mock（不触达模型 / 网络）
os.environ.setdefault("MOCK", "true")
# 与 test_http.py 相同：serve.py import 时 makedirs(upload_dir)，
# 默认 /app/uploads 本地不可写，先指到临时目录
os.environ.setdefault("UPLOAD_DIR", os.path.join(tempfile.gettempdir(), "agentcorp-test-uploads"))

from app.scoring.encoder import encode_summary  # noqa: E402
from app.scoring.convergence import (  # noqa: E402
    CandidateEmbedding,
    TurnState,
    ConvergenceTrace,
)
# 08-07 serve 拆分后，收敛引擎状态（store/锁/落盘）内聚在 routes.convergence；
# monkeypatch 必须指向该模块（patch serve 上的名字不会影响其函数读取的模块全局）。
from app.routes import convergence as conv  # noqa: E402


def _make_trace(run_id: str) -> ConvergenceTrace:
    """构造一条 K=3 的合法收敛轨迹（turn 0..3，每轮 3 候选）。"""
    turns = [
        TurnState(
            turn=t,
            candidates=[
                CandidateEmbedding(
                    candidateId=f"{run_id}-t{t}-c{i}",
                    turn=t,
                    summaryText=f"cand {i} turn {t}",
                    embedding=encode_summary(f"cand {i} turn {t}"),
                    jobType="code",
                )
                for i in range(3)
            ],
            beliefEmbedding=encode_summary(f"belief turn {t}"),
        )
        for t in range(4)
    ]
    return ConvergenceTrace(
        runId=run_id,
        agentId="agent-hardening",
        jobType="code",
        k=3,
        turns=turns,
        createdBy="test",
        ts="2026-08-07T00:00:00+00:00",
    )


@pytest.fixture()
def serve_mod(tmp_path, monkeypatch):
    """导入 serve；落盘路径隔离到 tmp_path，store 用前/用后清空。"""
    from app import config, serve

    config.settings.mock = True  # 走 Mock，避免触达模型加载
    monkeypatch.setattr(conv, "_CONV_STORE_PATH", str(tmp_path / "conv-store.json"))
    with conv._TRACE_LOCK:
        conv._TRACE_STORE.clear()
    yield serve
    with conv._TRACE_LOCK:
        conv._TRACE_STORE.clear()


def _post_evaluate_run(serve) -> list:
    """POST /api/evaluate-run（带 convergence），解析 SSE 为 (event, data) 列表。"""
    from fastapi.testclient import TestClient

    client = TestClient(serve.app)
    body = {
        "agentId": "agent-hardening",
        "agentName": "Hardening Agent",
        "task": {"title": "design", "description": "build a login page", "weight": 1},
        "transcript": "user: make a login page",
        "usage": [{"totalTokens": 100, "costUsd": 0.01}],
        "convergence": {"k": 3, "captureSummaries": True},
    }
    r = client.post("/api/evaluate-run", json=body)
    assert r.status_code == 200, r.text
    events = []
    cur = None
    for line in r.text.split("\n"):
        line = line.strip()
        if line.startswith("event:"):
            cur = line.split(":", 1)[1].strip()
        elif line.startswith("data:") and cur:
            events.append((cur, json.loads(line.split(":", 1)[1].strip())))
            cur = None
    return events


# ======================================================================
# R1：_TRACE_STORE 并发保护（smoke）
# ======================================================================
def test_trace_store_concurrent_writes_smoke(serve_mod):
    """多线程并发记录轨迹：无异常、store 完整、落盘文件未交错/截断。"""
    serve = serve_mod
    n = 16
    errors = []

    def worker(i: int) -> None:
        try:
            resp = conv.api_convergence_trace(_make_trace(f"run-conc-{i}"))
            assert resp["persisted"] is True
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"并发写入出现异常：{errors}"
    with conv._TRACE_LOCK:
        assert len(conv._TRACE_STORE) == n
    # 最后一次落盘（全程持锁，快照+写文件原子）必含全部 n 条
    with open(conv._CONV_STORE_PATH, encoding="utf-8") as fh:
        payload = json.load(fh)  # 文件可被完整解析即未被多线程写交错
    assert len(payload["traces"]) == n


# ======================================================================
# R2：持久化失败显式化（不再静默）
# ======================================================================
def test_persist_failure_returns_false_and_logs_stack(serve_mod, tmp_path, monkeypatch, caplog):
    """落盘路径不可写 → 返回 False + logger.exception 带堆栈 + 响应 persisted=false。"""
    serve = serve_mod
    bad_path = tmp_path / "no-such-dir" / "store.json"  # 父目录不存在 → open 必失败
    monkeypatch.setattr(conv, "_CONV_STORE_PATH", str(bad_path))

    with caplog.at_level(logging.ERROR, logger="serve"):
        ok = conv._persist_convergence()
    assert ok is False
    assert any(
        r.name == "serve" and r.levelno == logging.ERROR and r.exc_info
        for r in caplog.records
    ), "持久化失败必须 log exception（带堆栈），不得静默"

    resp = conv.api_convergence_trace(_make_trace("run-fail-1"))
    assert resp["persisted"] is False


def test_evaluate_run_persist_failure_marked_in_sse(serve_mod, tmp_path, monkeypatch):
    """SSE 路径：落盘失败 → convergence_score 事件显式携带 persisted: false。"""
    serve = serve_mod
    bad_path = tmp_path / "no-such-dir" / "store.json"
    monkeypatch.setattr(conv, "_CONV_STORE_PATH", str(bad_path))

    events = _post_evaluate_run(serve)
    scores = [d for t, d in events if t == "convergence_score"]
    assert scores, f"缺少 convergence_score，事件={[t for t, _ in events]}"
    assert scores[0]["persisted"] is False


# ======================================================================
# R3：合成轨迹诚实标注（source=projected / synthetic=true）
# ======================================================================
def test_evaluate_run_events_labeled_projected(serve_mod):
    """convergence_update/score 事件 payload 显式标注 MVP 投影，且落盘成功 persisted=true。"""
    events = _post_evaluate_run(serve_mod)
    updates = [d for t, d in events if t == "convergence_update"]
    scores = [d for t, d in events if t == "convergence_score"]
    assert updates, "缺少 convergence_update"
    assert scores, "缺少 convergence_score"
    for d in updates:
        assert d["source"] == "projected"
        assert d["synthetic"] is True
        assert "turn" in d and "candidates" in d  # 旧字段语义不变（向后兼容）
    assert scores[0]["source"] == "projected"
    assert scores[0]["synthetic"] is True
    assert scores[0]["persisted"] is True
    assert "convergence_score" in scores[0]  # 旧字段语义不变（向后兼容）
