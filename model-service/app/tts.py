"""
model-service/app/tts.py
语音合成统一接口（架构 D5：MiniCPM-o 原生 TTS / 系统 TTS 旁路）。

分层实现（TTS_BACKEND=auto|model|system|none，默认 auto）：
1. 模型原生 TTS：MiniCPM-o 4.5 generate_audio（use_tts_template + 临时 wav 落盘读回）。
2. 系统 TTS 兜底（开发机便利，shutil.which 惰性检测）：
   macOS `say` + `afconvert` 转 16k wav；Linux `espeak-ng`/`espeak` 直出 wav。
3. 返回空字节（不报错），前端 Mock 模式以 speechSynthesis 补「说」。

所有重依赖（模型 / 外部命令）惰性检测，失败即降级下一层。
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import tempfile
from typing import Optional

logger = logging.getLogger("tts")


class TTSBridge:
    """TTS 统一桥接（原生 / 系统旁路可替换，前端无感）。"""

    def __init__(self) -> None:
        self.available = False

    def synthesize(self, text: str) -> bytes:
        """
        合成语音，返回 wav 音频字节；任一层不可用即降级，全不可用返回空字节。
        """
        if not text:
            return b""
        backend = os.getenv("TTS_BACKEND", "auto").lower()
        if backend in ("auto", "model"):
            audio = self._synthesize_model(text)
            if audio:
                return audio
        if backend in ("auto", "system"):
            audio = self._synthesize_system(text)
            if audio:
                return audio
        if backend not in ("auto", "model", "system", "none"):
            logger.warning("未识别的 TTS_BACKEND=%r，按 none 处理", backend)
        return b""

    # ------------------------------------------------------------------
    # 第 1 层：模型原生 TTS（MiniCPM-o generate_audio）
    # ------------------------------------------------------------------
    def _synthesize_model(self, text: str) -> Optional[bytes]:
        # 延迟导入避免循环依赖（model_loader 不依赖 tts，但保持单向）
        from .model_loader import get_model

        wrapper = get_model()
        if not wrapper.available or not hasattr(wrapper.model, "chat"):
            return None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                out_path = tmp.name
            try:
                wrapper.model.chat(
                    msgs=[{"role": "user", "content": f"请用自然清晰的语气朗读：{text}"}],
                    use_tts_template=True,
                    generate_audio=True,
                    output_audio_path=out_path,
                    enable_thinking=False,
                )
                with open(out_path, "rb") as f:
                    data = f.read()
                if data:
                    return data
                logger.warning("模型 TTS 输出为空，降级下一层")
                return None
            finally:
                try:
                    os.unlink(out_path)
                except OSError:
                    pass
        except Exception as exc:  # noqa: BLE001
            logger.warning("模型原生 TTS 失败，降级下一层：%s", exc)
            return None

    # ------------------------------------------------------------------
    # 第 2 层：系统 TTS 兜底（macOS say / Linux espeak）
    # ------------------------------------------------------------------
    def _synthesize_system(self, text: str) -> Optional[bytes]:
        if sys.platform == "darwin" and shutil.which("say") and shutil.which("afconvert"):
            return self._system_macos_say(text)
        espeak = shutil.which("espeak-ng") or shutil.which("espeak")
        if espeak:
            return self._system_espeak(espeak, text)
        return None

    @staticmethod
    def _system_macos_say(text: str) -> Optional[bytes]:
        """macOS：say 输出 aiff → afconvert 转 16kHz PCM16 wav。"""
        aiff_path = wav_path = ""
        try:
            with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as tmp:
                aiff_path = tmp.name
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                wav_path = tmp.name
            subprocess.run(
                ["say", "-o", aiff_path, text], check=True, capture_output=True
            )
            subprocess.run(
                ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", aiff_path, wav_path],
                check=True,
                capture_output=True,
            )
            with open(wav_path, "rb") as f:
                return f.read()
        except Exception as exc:  # noqa: BLE001
            logger.warning("系统 TTS（say/afconvert）失败：%s", exc)
            return None
        finally:
            for p in (aiff_path, wav_path):
                if p:
                    try:
                        os.unlink(p)
                    except OSError:
                        pass

    @staticmethod
    def _system_espeak(binary: str, text: str) -> Optional[bytes]:
        """Linux：espeak-ng/espeak 直出 wav。"""
        wav_path = ""
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                wav_path = tmp.name
            subprocess.run(
                [binary, "-w", wav_path, text], check=True, capture_output=True
            )
            with open(wav_path, "rb") as f:
                return f.read()
        except Exception as exc:  # noqa: BLE001
            logger.warning("系统 TTS（%s）失败：%s", binary, exc)
            return None
        finally:
            if wav_path:
                try:
                    os.unlink(wav_path)
                except OSError:
                    pass


# 全局单例
tts_bridge = TTSBridge()
