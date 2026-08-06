# 实现记录：08-07-real-inference

## 改动文件

| 文件 | 改动 |
|------|------|
| `model-service/app/model_loader.py` | 重写：新增 `optional_import()` 惰性导入；`resolve_device()` 设备选择（NPU>CUDA>CPU，`settings.device` 生效，不可用时降级+warning）；`load_minicpmo()` 真实加载（官方 4.5 用法：trust_remote_code/sdpa/bf16(CPU fp32)/init_vision,audio,tts + `init_tts()` + AutoTokenizer），缺依赖/缺权重/加载异常均优雅降级 `available=False`；`to_npu()` 从透传改为真实 `model.to(device)`；`MiniCPMModel` 新增 `device` 属性。 |
| `model-service/app/evaluator.py` | §4 重写：`load_media()` 真实加载——PIL 图像（最长边≤1024）、librosa 音频（16k mono numpy）、cv2 视频均匀抽帧（`FRAME_SAMPLE`，确定性索引）；文件缺失/依赖缺失降级为空媒体+warning；URL 解析 `/uploads/`→`upload_dir`、http(s) 跳过、其余按 FS 路径。`infer()` 真实调用 `model.chat()`（media 并入 user content 列表，含媒体 `omni_mode=True`，`do_sample=temperature>0`）；模型缺失抛含指引的 RuntimeError。 |
| `model-service/app/tts.py` | 重写：三层兜底——①模型原生 TTS（`generate_audio`+临时 wav 读回）②系统 TTS（macOS `say`+`afconvert` / Linux `espeak(-ng)`，which 惰性检测）③空字节。`TTS_BACKEND=auto|model|system|none` 控制。 |
| `model-service/requirements.txt` | 昇腾注释块改为分组可选安装清单（官方版本基线 transformers==4.51.0 / torch 2.3–2.8 / minicpmo-utils / librosa / opencv-python / torch_npu / flag_gems），不进硬依赖。 |
| `README.md` | §4 新增「真实模式安装（MOCK=false，可选推理依赖）」小节。 |
| `model-service/tests/test_real_inference.py` | 新增 26 个用例：设备选择 8、加载降级/真实加载 3、infer 3、load_media 5、tts 7。重依赖全部 monkeypatch/假模块。 |

## 设计决策

见 `prd.md` Design Decisions（D1 可注入假 torch 的纯函数设备选择；D2 load_media 返回真实载荷结构——消费方仅 infer，Mock 流不经过；D3 音频选 librosa 对齐官方；D4 视频 cv2 均匀抽帧；D5 系统 TTS 仅开发机便利；D6 契约零改动）。

## 验证

- `cd model-service && .venv/bin/python -m pytest tests/ -q` → **166 passed, 6 skipped**（基线 140 passed + 新增 26，skip 数不变）。
- 本机 macOS 冒烟：`TTS_BACKEND=system` 下 `synthesize()` 实测返回 74258 字节 RIFF wav（say+afconvert 路径实测可用）。
- 未装 torch 环境（本机 .venv 即如此）：`import app.*` 与全部测试正常，`/health` 路径返回 `model_available=false` 不崩溃。

## 未实测清单（诚实边界）

- NPU 实机加载/推理：device=npu 分支、torch_npu/flag_gems 注册、bf16 显存行为未实测（本机无 NPU）。
- 真实权重前向：`model.chat()` 输出质量、`omni_mode` 细节、CPU 推理速度未实测（无权重）。
- 模型原生 TTS wav 输出与前端解码兼容性未实测。
- Linux espeak 系统 TTS 路径未实测（仅 macOS say 实测）。

## 边界

- MOCK=true 路径零改动：`_stream_mock*` 不经过 load_media/infer/tts，既有 140 测试全部保持绿色。
- 未做任何 git commit/push（archive 脚本的 auto-commit 属工具内建行为）。
