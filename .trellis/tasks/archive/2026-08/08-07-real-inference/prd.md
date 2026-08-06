# 真实推理路径：infer/tts/load_media 非骨架实现

## Goal

让 model-service 的「真实模式」（`MOCK=false`）从纯骨架变为一条代码完整、可运行的 MiniCPM-o 4.5 推理路径：模型加载（NPU>CUDA>CPU 设备选择）、多模态媒体加载、跨模态推理、TTS 语音合成，全部真实实现；重依赖惰性加载，评委机（无 NPU、无权重、无 torch）上骨架/测试行为零回归。

## Background

- `app/model_loader.py`：`load_minicpmo()` 只打日志返回 `available=False`；`to_npu` 是透传 stub；`config.device`（`DEVICE` 环境变量，默认 `npu`）无人消费。
- `app/evaluator.py`：`infer()` 永远 `raise RuntimeError`；`load_media()` 返回占位 dict（frames=int/images=int）。
- `app/tts.py`：`synthesize()` 永远返回 `b""`。
- 昇腾适配方案 `docs/ascend-adaptation-plan.md` §2.3/§4.3 已给出改造点：后端 import（flag_gems/torch_npu）、`settings.device` 生效、优雅降级不变。
- MiniCPM-o 4.5 官方离线用法（[HF 模型卡](https://huggingface.co/openbmb/MiniCPM-o-4_5)）：
  - `AutoModel.from_pretrained(path, trust_remote_code=True, attn_implementation="sdpa", torch_dtype=torch.bfloat16, init_vision/init_audio/init_tts=True)`；`model.eval()`；音频输出前 `model.init_tts()`。
  - 推理 `model.chat(msgs=..., do_sample=..., temperature=..., omni_mode=True(含音视频输入时必需), enable_thinking=False, max_new_tokens=...)`；`msgs` 的 content 为混合列表（PIL 图像 / numpy 音频波形 / str）。
  - 原生 TTS：`model.chat(..., use_tts_template=True, generate_audio=True, output_audio_path=...)` 落盘 wav。
  - 官方依赖基线：`transformers==4.51.0`、`torch>=2.3.0,<=2.8.0`、`torchaudio`、`minicpmo-utils>=1.0.5`；音频输入 `librosa.load(path, sr=16000, mono=True)`。

## Requirements

1. **model_loader.py 真实加载**
   - 惰性 import torch/transformers/torch_npu/flag_gems（提供 `optional_import()` 辅助）；缺依赖时 `available=False` + 明确安装指引日志，绝不 ImportError 崩溃。
   - 设备选择 `resolve_device()`：**NPU（torch_npu 可导入且 `torch.npu.is_available()`）> CUDA（`torch.cuda.is_available()`）> CPU**；`settings.device` 真正生效：`npu/cuda/cpu/auto`，请求的设备不可用时按优先级降级并记 warning。
   - 权重路径沿用 `MODEL_PATH`（`settings.model_path`）；路径不存在 → `available=False` + 日志，不崩溃。
   - 加载按官方 4.5 用法（trust_remote_code + sdpa + bf16（CPU 用 fp32）+ init_vision/audio/tts + `init_tts()`）；`to_npu()` 从透传改为真实 `model.to(device)`（默认目标 = `resolve_device()`）。
2. **evaluator.infer()**：模型不可用 → 保持 RuntimeError（信息含「MOCK=true / 安装可选依赖」指引）；可用时合并 media 与 messages 调 `model.chat()` 返回文本。`do_sample = settings.temperature > 0`（temperature=0 → 贪心，复现性）；含媒体时 `omni_mode=True`。
3. **load_media()**：真实加载——图像 PIL（最长边 ≤1024）、音频 librosa（16kHz mono numpy）、视频 opencv 均匀抽帧（`settings.frame_sample`）；全部惰性 import。文件不存在/依赖缺失 → 优雅降级为空媒体 + warning 日志，不中断评估。URL 解析：`/uploads/...` 前缀映射到 `settings.upload_dir`，http(s) 不抓取（记日志跳过），其余按文件系统路径。
4. **tts.py synthesize() 分层**：① 模型原生 TTS（`generate_audio` + 临时 wav → 读字节）；② 系统 TTS 兜底（macOS `say`+`afconvert` / Linux `espeak(-ng)`，`shutil.which` 惰性检测）；③ 返回 `b""`（现状，调用方已容忍）。`TTS_BACKEND=auto|model|system|none` 控制，默认 auto。
5. **依赖纪律**：torch/transformers/torch_npu/librosa/opencv 不进 requirements.txt 硬依赖；注释块写明可选安装组与官方版本基线；README 补「真实模式安装」小节。
6. **测试**：新增 pytest 覆盖设备选择优先级与 config.device 生效、infer 模型缺失错误信息与真实调用参数、load_media 降级与真实图像加载、tts 三层兜底；重依赖一律 monkeypatch/mock。既有 140 测试全绿。
7. **MOCK=true 路径零变化**。

## Design Decisions（记录备查）

- **D1 设备选择**：统一 `resolve_device(torch_mod=None)` 纯函数便于单测（注入假 torch）；NPU 判定 = `optional_import("torch_npu")` 成功 + `torch.npu.is_available()`，与适配方案 §2.3 的 `ASCEND_BACKEND=flag_gems|torch_npu` 双后端保留（import 即生效）。
- **D2 load_media 返回结构变更**：由占位元数据 dict 改为真实载荷 dict（`frames: List[PIL.Image]`、`audio: np.ndarray|None`、`images: List[PIL.Image]`、`code_lang: str`）。消费方只有 `infer()`（grep 确认无测试依赖旧形状），Mock 流不经过 load_media，变更安全。
- **D3 音频方案选 librosa**：与官方用法一致且已是适配方案列出的可选依赖；不选 `wave`（仅支持 wav 且需手写重采样）。
- **D4 视频抽帧选 opencv（cv2）**：均匀抽 `FRAME_SAMPLE` 帧，BGR→RGB→PIL；cv2 缺失时仅丢视频模态，不阻塞。
- **D5 TTS 系统兜底仅为开发机便利**：macOS `say -o aiff` + `afconvert -f WAVE -d LEI16` 转 16k wav；Linux `espeak-ng -w wav`。生产（NPU 容器）走模型原生 TTS，系统层自然检测不到即跳过。
- **D6 不改动契约**：SSE 事件结构、`/health` 字段、`MiniCPMModel` 既有字段全部保留（仅新增 `device` 属性）。

## Acceptance Criteria

- [ ] PRD 完整（本文件）。
- [ ] `MOCK=false` + 已装依赖 + 权重就位时，代码路径完整可走通（本机无 NPU/权重，**端到端未实测**，逐项标注）。
- [ ] 新增测试全部通过；`cd model-service && .venv/bin/python -m pytest tests/ -q` 全绿（≥140 passed）。
- [ ] 未装 torch 时 `import app.model_loader / app.evaluator / app.tts` 不崩，`/health` 正常返回 `model_available=false`。
- [ ] MOCK=true 事件流行为与基线完全一致。

## Honest Boundaries（未实测清单）

- NPU 实机加载与推理（无 NPU）：device=npu 分支、torch_npu/flag_gems 注册、bf16 显存占用均未实测。
- 真实权重前向（无权重）：`model.chat()` 的输出质量、`omni_mode` 细节、CPU 推理速度未实测。
- 模型原生 TTS 的 wav 输出格式（采样率 24000 依官方）与前端解码兼容性未实测。
- 系统 TTS 兜底在 macOS 本机可实测 `say` 路径；Linux espeak 路径未实测。
