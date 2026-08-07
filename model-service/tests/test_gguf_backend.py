"""
model-service/tests/test_gguf_backend.py

GGUF（llama.cpp）后端单测：路径分发、优雅降级、chat 适配器契约。
llama_cpp 与权重文件均用 monkeypatch/mock，不依赖真实模型。

运行：cd model-service && .venv/bin/python -m pytest tests/test_gguf_backend.py -q
"""
from __future__ import annotations

import types

import pytest

from app import model_loader
from app.model_loader import MiniCPMModel, _GgufChatAdapter, load_minicpmo


class TestGgufDispatch:
    def test_gguf_suffix_routes_to_gguf_loader(self, monkeypatch, tmp_path):
        gguf = tmp_path / "model.gguf"
        gguf.write_bytes(b"GGUF")
        called = {}
        monkeypatch.setattr(
            model_loader,
            "_load_gguf",
            lambda p: called.setdefault("path", p) or MiniCPMModel(),
        )
        load_minicpmo(str(gguf))
        assert called["path"] == str(gguf)

    def test_gguf_file_missing_unavailable(self):
        model = load_minicpmo("/nonexistent/model.gguf")
        assert model.available is False

    def test_llama_cpp_missing_unavailable(self, monkeypatch, tmp_path):
        gguf = tmp_path / "model.gguf"
        gguf.write_bytes(b"GGUF")
        monkeypatch.setattr(model_loader, "optional_import", lambda name: None)
        model = load_minicpmo(str(gguf))
        assert model.available is False


class TestGgufChatAdapter:
    def _adapter(self) -> _GgufChatAdapter:
        captured = {}

        class _FakeLlama:
            def create_chat_completion(self, **kwargs):
                captured.update(kwargs)
                return {"choices": [{"message": {"content": '{"ok": true}'}}]}

        adapter = _GgufChatAdapter(_FakeLlama())
        adapter._captured = captured  # type: ignore[attr-defined]
        return adapter

    def test_text_content_passthrough(self):
        adapter = self._adapter()
        out = adapter.chat(msgs=[{"role": "user", "content": "你好"}])
        assert out == '{"ok": true}'
        assert adapter._captured["messages"] == [{"role": "user", "content": "你好"}]

    def test_multimodal_content_list_flattened_to_text(self):
        """evaluator.infer 的多模态 content 列表只保留文本段。"""
        adapter = self._adapter()
        fake_image = types.SimpleNamespace()
        adapter.chat(
            msgs=[{"role": "user", "content": [fake_image, "描述这张图", 123]}]
        )
        assert adapter._captured["messages"][0]["content"] == "描述这张图"

    def test_greedy_when_not_do_sample(self):
        adapter = self._adapter()
        adapter.chat(msgs=[], do_sample=False, temperature=0.7)
        assert adapter._captured["temperature"] == 0.0

    def test_sampling_temperature_passthrough(self):
        adapter = self._adapter()
        adapter.chat(msgs=[], do_sample=True, temperature=0.7)
        assert adapter._captured["temperature"] == 0.7

    def test_missing_role_defaults_user(self):
        adapter = self._adapter()
        adapter.chat(msgs=[{"content": "hi"}])
        assert adapter._captured["messages"][0]["role"] == "user"
