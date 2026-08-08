"""
model-service/tests/test_http.py
HTTP 层契约验证（fastapi.testclient.TestClient，不依赖真实模型 / NPU）。

覆盖评审确认的核心承诺：
  1) MOCK=true 时 /health 返回 200 且字段正常；
  2) MOCK=true 时 /api/evaluate-run 返回 200、为 SSE 流、包含 done 事件；
  3) MOCK=false 且模型不可用时 /api/evaluate 返回 503（优雅降级，不再 500）。

注意：app 导入时会对 settings.upload_dir 做 makedirs + StaticFiles 挂载，
默认路径 /app/uploads 在本地开发机不可写，因此在导入 app 前将
UPLOAD_DIR 指向系统临时目录（不影响断言内容）。

运行（在 model-service 目录下）：
    python -m pytest tests/test_http.py -q
"""
from __future__ import annotations

import os
import sys
import tempfile

# 必须在导入 app 之前处理 upload_dir：serve.py 在 import 时
# makedirs(settings.upload_dir) 并挂载 StaticFiles；默认路径 /app/uploads
# 在本地开发机不可写。由于 pytest 收集时其他测试模块可能已导入
# app.config（settings 单例已创建），这里既设环境变量（settings 未创建时
# 生效）又直接覆写单例属性（已创建时生效）。
os.environ.setdefault("UPLOAD_DIR", os.path.join(tempfile.gettempdir(), "agentcorp-test-uploads"))

# 让测试能 import app 包
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import settings  # noqa: E402

settings.upload_dir = os.environ["UPLOAD_DIR"]

from app.serve import app  # noqa: E402


def _client() -> TestClient:
    return TestClient(app)


# ----------------------------------------------------------------------
# 1) MOCK=true 时 /health 返回 200 且字段正常
# ----------------------------------------------------------------------
def test_health_mock_ok(monkeypatch):
    monkeypatch.setattr(settings, "mock", True)
    resp = _client().get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["mock"] is True
    # 骨架环境无 NPU，模型不可用但必须能正常上报（而非 500）
    assert body["model_available"] is False


# ----------------------------------------------------------------------
# 2) MOCK=true 时 /api/evaluate-run 返回 200 的 SSE 流且包含 done 事件
# ----------------------------------------------------------------------
def test_evaluate_run_mock_sse(monkeypatch):
    monkeypatch.setattr(settings, "mock", True)
    payload = {
        "agentId": "agent-http-01",
        "agentName": "agent-http-01",
        "task": {"title": "Build dashboard", "description": "...", "weight": 1.0},
        "transcript": "user: build a chart\nagent: done",
        "usage": [
            {
                "timestamp": "2025-01-01T00:00:00Z",
                "sessionId": "sess-1",
                "agentId": "agent-http-01",
                "inputTokens": 1000,
                "outputTokens": 500,
                "totalTokens": 1500,
                "costUsd": 0.3,
            }
        ],
    }
    with _client() as client:
        resp = client.post("/api/evaluate-run", json=payload)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    text = resp.text
    # 同构事件序列：radar_update ×6 + verdict + done
    assert text.count("event: radar_update") == 6
    assert "event: verdict" in text
    assert "event: done" in text
    assert "event: error" not in text


# ----------------------------------------------------------------------
# 3) MOCK=false 且模型不可用时 /api/evaluate 返回 503（核心承诺：优雅降级而非 500）
# ----------------------------------------------------------------------
def test_evaluate_503_when_model_unavailable(monkeypatch):
    monkeypatch.setattr(settings, "mock", False)
    # 评测后端（judge_backend）与本地权重都不可用时（默认 JUDGE_BACKEND=mock），
    # /api/evaluate 必须明确拒绝（503）并给出配置指引，绝不静默走伪造分。
    payload = {
        "candidate": {"id": "candidate-01", "name": "琳达"},
        "preference": {},
    }
    resp = _client().post("/api/evaluate", json=payload)
    assert resp.status_code == 503
    assert "评测后端不可用" in resp.json()["detail"]
    assert "JUDGE_BACKEND" in resp.json()["detail"]


if __name__ == "__main__":
    class _DummyMonkeyPatch:
        def setattr(self, obj, name, value):
            setattr(obj, name, value)

    mp = _DummyMonkeyPatch()
    test_health_mock_ok(mp)
    test_evaluate_run_mock_sse(mp)
    test_evaluate_503_when_model_unavailable(mp)
    print("tests/test_http.py 全部通过 ✅")
