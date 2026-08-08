"""
model-service/tests/test_real_inference.py
真实推理路径（MOCK=false）单元测试：设备选择、infer、load_media、tts 分层兜底。

所有重依赖（torch/transformers/torch_npu/librosa/cv2/系统 TTS 命令）一律
monkeypatch / 假模块注入，不在测试环境真装。

运行（在 model-service 目录下）：
    .venv/bin/python -m pytest tests/test_real_inference.py -q
"""
from __future__ import annotations

import os
import sys
import types

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app.evaluator as evaluator  # noqa: E402
import app.model_loader as model_loader  # noqa: E402
import app.tts as tts  # noqa: E402
from app.config import settings  # noqa: E402
from app.model_loader import MiniCPMModel  # noqa: E402
from app.schemas import CandidateProfile  # noqa: E402


# ======================================================================
# 工具：假 torch / transformers
# ======================================================================
def _fake_torch(npu_ok: bool = False, cuda_ok: bool = False) -> types.SimpleNamespace:
    return types.SimpleNamespace(
        npu=types.SimpleNamespace(is_available=lambda: npu_ok),
        cuda=types.SimpleNamespace(is_available=lambda: cuda_ok),
        float32="float32",
        bfloat16="bfloat16",
    )


class _FakeModel:
    """模拟 MiniCPM-o：eval / to / init_tts / chat。"""

    def __init__(self) -> None:
        self.moved_to: str = ""
        self.tts_inited = False
        self.chat_kwargs: dict = {}

    def eval(self):
        return self

    def to(self, device):
        self.moved_to = device
        return self

    def init_tts(self):
        self.tts_inited = True

    def chat(self, **kwargs):
        self.chat_kwargs = kwargs
        return '{"radar": {}, "verdict": "OBSERVE"}'


def _fake_transformers(model: _FakeModel) -> types.SimpleNamespace:
    auto_model = types.SimpleNamespace(
        from_pretrained=lambda *a, **kw: model
    )
    auto_tokenizer = types.SimpleNamespace(from_pretrained=lambda *a, **kw: "tok")
    return types.SimpleNamespace(AutoModel=auto_model, AutoTokenizer=auto_tokenizer)


# ======================================================================
# 1) 设备选择 resolve_device
# ======================================================================
class TestResolveDevice:
    @pytest.fixture(autouse=True)
    def _no_torch_npu(self, monkeypatch):
        """默认环境无 torch_npu（测试机）；单测内按需覆盖。"""
        monkeypatch.setattr(
            model_loader, "optional_import", lambda name: None
        )

    def test_npu_preferred_when_requested_and_available(self, monkeypatch):
        monkeypatch.setattr(settings, "device", "npu")
        # torch_npu 可导入
        monkeypatch.setattr(
            model_loader,
            "optional_import",
            lambda name: object() if name == "torch_npu" else None,
        )
        assert model_loader.resolve_device(_fake_torch(npu_ok=True)) == "npu"

    def test_npu_requested_but_unavailable_falls_back_cuda(self, monkeypatch):
        monkeypatch.setattr(settings, "device", "npu")
        assert model_loader.resolve_device(_fake_torch(npu_ok=False, cuda_ok=True)) == "cuda"

    def test_npu_unavailable_falls_back_cpu(self, monkeypatch):
        monkeypatch.setattr(settings, "device", "npu")
        assert model_loader.resolve_device(_fake_torch()) == "cpu"

    def test_cuda_requested(self, monkeypatch):
        monkeypatch.setattr(settings, "device", "cuda")
        assert model_loader.resolve_device(_fake_torch(cuda_ok=True)) == "cuda"

    def test_cuda_unavailable_falls_back_cpu(self, monkeypatch):
        monkeypatch.setattr(settings, "device", "cuda")
        assert model_loader.resolve_device(_fake_torch()) == "cpu"

    def test_cpu_forced(self, monkeypatch):
        monkeypatch.setattr(settings, "device", "cpu")
        assert model_loader.resolve_device(_fake_torch(npu_ok=True, cuda_ok=True)) == "cpu"

    def test_auto_priority(self, monkeypatch):
        monkeypatch.setattr(settings, "device", "auto")
        assert model_loader.resolve_device(_fake_torch(cuda_ok=True)) == "cuda"
        assert model_loader.resolve_device(_fake_torch()) == "cpu"

    def test_no_torch_returns_cpu(self, monkeypatch):
        monkeypatch.setattr(settings, "device", "npu")
        assert model_loader.resolve_device(None) == "cpu"


# ======================================================================
# 2) load_minicpmo 优雅降级与真实加载路径
# ======================================================================
class TestLoadMinicpmo:
    def test_missing_deps_unavailable(self, monkeypatch):
        monkeypatch.setattr(model_loader, "optional_import", lambda name: None)
        m = model_loader.load_minicpmo("/nonexistent")
        assert m.available is False

    def test_missing_weights_unavailable(self, monkeypatch):
        fake = {"torch": _fake_torch(), "transformers": _fake_transformers(_FakeModel())}
        monkeypatch.setattr(
            model_loader, "optional_import", lambda name: fake.get(name)
        )
        m = model_loader.load_minicpmo("/nonexistent/model-path")
        assert m.available is False

    def test_real_load_cpu(self, monkeypatch, tmp_path):
        fake_model = _FakeModel()
        fake = {
            "torch": _fake_torch(),
            "transformers": _fake_transformers(fake_model),
        }
        monkeypatch.setattr(
            model_loader, "optional_import", lambda name: fake.get(name)
        )
        monkeypatch.setattr(settings, "device", "cpu")
        m = model_loader.load_minicpmo(str(tmp_path))  # 目录存在即视为权重就位
        assert m.available is True
        assert m.device == "cpu"
        assert m.model.moved_to == "cpu"
        assert m.model.tts_inited is True
        assert m.processor == "tok"


# ======================================================================
# 3) infer：LLM-as-judge 接口契约（后端不可用明确报错；可用时透传后端产出）
# ======================================================================
class TestInfer:
    def test_unavailable_backend_raises(self):
        """契约：后端不可用（默认 mock）→ 抛 JudgeUnavailable，绝不伪造分数。"""
        from app.judge_backend import JudgeUnavailable

        with pytest.raises(JudgeUnavailable) as exc_info:
            evaluator.infer({}, [{"role": "user", "content": "x"}])
        assert "JUDGE_BACKEND" in str(exc_info.value)

    def test_uses_backend_completion(self, monkeypatch):
        """真实路径：infer 收敛为 judge_backend.complete(messages) 的透传。"""
        from app.judge_backend import JudgeCompletion

        class _FakeBackend:
            name = "http"
            available = True

            def complete(self, messages, **kwargs):
                return JudgeCompletion(text='{"radar": {}}', backend="http", latency_ms=1.0)

        monkeypatch.setattr(evaluator, "get_backend", lambda: _FakeBackend())
        out = evaluator.infer({"frames": 8}, [{"role": "user", "content": "评估"}])
        assert out == '{"radar": {}}'

    def test_media_passthrough(self, monkeypatch):
        """媒体载荷只作日志指标；推理语义完全由后端承载（多模态通道在 LocalJudgeBackend）。"""
        from app.judge_backend import JudgeCompletion

        class _FakeBackend:
            name = "local"
            available = True

            def complete(self, messages, **kwargs):
                return JudgeCompletion(text="ok", backend="local", latency_ms=2.0)

        monkeypatch.setattr(evaluator, "get_backend", lambda: _FakeBackend())
        assert evaluator.infer({"frames": 8, "audio": True, "images": ["img"]}, []) == "ok"


# ======================================================================
# 4) load_media：降级与真实加载
# ======================================================================
class TestLoadMedia:
    def test_missing_files_degrade(self, caplog):
        candidate = CandidateProfile(
            id="t-missing",
            video_demo={"type": "video/mp4", "url": "/no/such/video.mp4"},
            voice_intro={"type": "audio/wav", "url": "/no/such/voice.wav"},
            artwork=[{"type": "image/png", "url": "/no/such/img.png"}],
            code_repo={"type": "application/zip", "url": "", "lang": "python"},
        )
        with caplog.at_level("WARNING", logger="evaluator"):
            media = evaluator.load_media(candidate)
        assert media["frames"] == []
        assert media["audio"] is None
        assert media["images"] == []
        assert media["code_lang"] == "python"
        assert "不存在" in caplog.text

    def test_real_image_loading_and_resize(self, tmp_path):
        Image = pytest.importorskip("PIL.Image")
        img_path = tmp_path / "art.png"
        Image.new("RGB", (2000, 100)).save(img_path)
        candidate = CandidateProfile(
            id="t-img",
            artwork=[{"type": "image/png", "url": str(img_path)}],
        )
        media = evaluator.load_media(candidate)
        assert len(media["images"]) == 1
        assert max(media["images"][0].size) <= 1024  # 最长边约束生效

    def test_uploads_prefix_mapping(self, monkeypatch, tmp_path):
        Image = pytest.importorskip("PIL.Image")
        monkeypatch.setattr(settings, "upload_dir", str(tmp_path))
        cid_dir = tmp_path / "c1"
        cid_dir.mkdir()
        Image.new("RGB", (10, 10)).save(cid_dir / "art.png")
        candidate = CandidateProfile(
            id="t-uploads",
            artwork=[{"type": "image/png", "url": "/uploads/c1/art.png"}],
        )
        media = evaluator.load_media(candidate)
        assert len(media["images"]) == 1

    def test_audio_with_fake_librosa(self, monkeypatch, tmp_path):
        wav_path = tmp_path / "v.wav"
        wav_path.write_bytes(b"RIFF....")
        fake_librosa = types.SimpleNamespace(
            load=lambda path, sr, mono: ("waveform@16k", sr)
        )
        monkeypatch.setattr(
            evaluator,
            "optional_import",
            lambda name: fake_librosa if name == "librosa" else None,
        )
        candidate = CandidateProfile(
            id="t-audio",
            voice_intro={"type": "audio/wav", "url": str(wav_path)},
        )
        media = evaluator.load_media(candidate)
        assert media["audio"] == "waveform@16k"

    def test_http_url_skipped(self):
        candidate = CandidateProfile(
            id="t-http",
            voice_intro={"type": "audio/wav", "url": "https://example.com/v.wav"},
        )
        media = evaluator.load_media(candidate)
        assert media["audio"] is None


# ======================================================================
# 5) TTS 分层兜底
# ======================================================================
class TestTTS:
    @pytest.fixture(autouse=True)
    def _no_model(self, monkeypatch):
        """默认模型不可用（隔离真实加载）。"""
        monkeypatch.setattr(model_loader, "get_model", lambda: MiniCPMModel())

    def test_empty_text(self):
        assert tts.tts_bridge.synthesize("") == b""

    def test_all_layers_unavailable_returns_empty(self, monkeypatch):
        monkeypatch.delenv("TTS_BACKEND", raising=False)
        monkeypatch.setattr(tts.shutil, "which", lambda name: None)
        assert tts.tts_bridge.synthesize("你好") == b""

    def test_backend_none_disables_all(self, monkeypatch):
        monkeypatch.setenv("TTS_BACKEND", "none")
        monkeypatch.setattr(tts.shutil, "which", lambda name: "/usr/bin/say")
        assert tts.tts_bridge.synthesize("你好") == b""

    def test_model_tts_first(self, monkeypatch):
        fake_model = _FakeModel()

        def _chat(**kwargs):
            with open(kwargs["output_audio_path"], "wb") as f:
                f.write(b"model-wav")
            return ""

        fake_model.chat = _chat
        monkeypatch.setattr(
            model_loader, "get_model", lambda: MiniCPMModel(model=fake_model)
        )
        # 系统层即便可用也不应被走到
        monkeypatch.setattr(
            tts.TTSBridge,
            "_synthesize_system",
            lambda self, text: pytest.fail("不应走到系统层"),
        )
        assert tts.tts_bridge.synthesize("讲解") == b"model-wav"

    def test_system_macos_say(self, monkeypatch):
        monkeypatch.setattr(tts.sys, "platform", "darwin")
        monkeypatch.setattr(
            tts.shutil,
            "which",
            lambda name: "/usr/bin/" + name if name in ("say", "afconvert") else None,
        )

        def fake_run(cmd, **kwargs):
            # say 的输出在 -o 之后（末位参数是文本）；afconvert 的输出在末位
            out_path = cmd[cmd.index("-o") + 1] if cmd[0] == "say" else cmd[-1]
            with open(out_path, "wb") as f:
                f.write(b"macos-wav")
            return types.SimpleNamespace(returncode=0)

        monkeypatch.setattr(tts.subprocess, "run", fake_run)
        assert tts.tts_bridge.synthesize("你好") == b"macos-wav"

    def test_system_espeak_linux(self, monkeypatch):
        monkeypatch.setattr(tts.sys, "platform", "linux")
        monkeypatch.setattr(
            tts.shutil,
            "which",
            lambda name: "/usr/bin/espeak-ng" if name == "espeak-ng" else None,
        )

        def fake_run(cmd, **kwargs):
            with open(cmd[cmd.index("-w") + 1], "wb") as f:
                f.write(b"espeak-wav")
            return types.SimpleNamespace(returncode=0)

        monkeypatch.setattr(tts.subprocess, "run", fake_run)
        assert tts.tts_bridge.synthesize("hello") == b"espeak-wav"

    def test_model_failure_falls_back_system(self, monkeypatch):
        class _BadModel:
            def chat(self, **kwargs):
                raise RuntimeError("tts broken")

        monkeypatch.setattr(
            model_loader, "get_model", lambda: MiniCPMModel(model=_BadModel())
        )
        monkeypatch.setattr(tts.sys, "platform", "linux")
        monkeypatch.setattr(
            tts.shutil,
            "which",
            lambda name: "/usr/bin/espeak" if name == "espeak" else None,
        )

        def fake_run(cmd, **kwargs):
            with open(cmd[cmd.index("-w") + 1], "wb") as f:
                f.write(b"fallback-wav")
            return types.SimpleNamespace(returncode=0)

        monkeypatch.setattr(tts.subprocess, "run", fake_run)
        assert tts.tts_bridge.synthesize("降级") == b"fallback-wav"
