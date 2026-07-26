"""
model-service/app/tts.py
语音合成统一接口（架构 D5：MiniCPM-o 原生 TTS / CosyVoice2 旁路）。

真实环境：synthesis 返回 PCM16/wav 字节，由 serve.py 以 base64 经 audio 事件下发。
无环境：返回空字节（优雅降级），前端 Mock 模式以 speechSynthesis 补「说」。
"""
from __future__ import annotations

import logging

logger = logging.getLogger("tts")


class TTSBridge:
    """TTS 统一桥接（原生 / 旁路可替换，前端无感）。"""

    def __init__(self) -> None:
        self.available = False

    def synthesize(self, text: str) -> bytes:
        """
        合成语音，返回音频字节（真实环境实现）。
        当前骨架无 TTS 依赖，返回空字节（不报错）。
        """
        # 真实环境示例（按官方 starter kit 适配）：
        #   import cosyvoice  # 或 MiniCPM-o 原生 TTS
        #   return cosyvoice.synthesize(text, ...)
        if not text:
            return b""
        logger.debug("TTS 合成（骨架占位）：%s", text[:30])
        return b""


# 全局单例
tts_bridge = TTSBridge()
