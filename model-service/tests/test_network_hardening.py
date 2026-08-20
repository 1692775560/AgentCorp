"""
model-service/tests/test_network_hardening.py
网络暴露面收口的回归测试：

  1) API_HOST 默认 127.0.0.1 —— 本服务无鉴权（judge/upload 直接可用，
     sandbox 开启时甚至是代码执行路径），默认绑 0.0.0.0 等于把这套能力
     白送给同网段任何人；
  2) CORS 不再是 allow_origins=["*"] —— 正常调用方是 Electron 主进程的
     Host API 代理（server-to-server，不需要 CORS），浏览器直连只允许
     本地 dev 预览来源；陌生 Origin 拿不到 access-control-allow-origin。

运行（在 model-service 目录下）：
    python -m pytest tests/test_network_hardening.py -q
"""
from __future__ import annotations

import os
import sys
import tempfile

# 同 test_http.py：app 导入时会 makedirs(upload_dir)，先指到可写临时目录
os.environ.setdefault("UPLOAD_DIR", os.path.join(tempfile.gettempdir(), "agentcorp-test-uploads"))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import Settings, settings  # noqa: E402

settings.upload_dir = os.environ["UPLOAD_DIR"]

from app.serve import app  # noqa: E402


def test_default_host_is_loopback(monkeypatch):
    """API_HOST 未设置时必须默认 127.0.0.1（显式设 0.0.0.0 才对外）。"""
    monkeypatch.delenv("API_HOST", raising=False)
    assert Settings().host == "127.0.0.1"


def test_cors_rejects_unknown_origin():
    resp = TestClient(app).get("/health", headers={"Origin": "https://evil.example.com"})
    assert resp.status_code == 200
    assert "access-control-allow-origin" not in resp.headers


def test_cors_allows_local_dev_origin():
    resp = TestClient(app).get("/health", headers={"Origin": "http://localhost:5173"})
    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-origin") == "http://localhost:5173"
