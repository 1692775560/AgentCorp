# PRD：真实后端落地（GGUF/llama.cpp 路径）

## 目标

让 model-service 在非 NPU 笔记本（16GB M4 Mac）上以**真实 MiniCPM-o 4.5 推理**跑通裁判链路，
不再依赖 Mock 数据。

## 方案

- 权重：openbmb/MiniCPM-o-4_5-gguf 的 Q4_K_M（约 4.7GB，ModelScope 下载），
  全量 bf16（约 18GB）超出 16GB 内存。
- 后端：llama.cpp（llama-cpp-python，Metal 构建），`MODEL_PATH` 指向 .gguf 文件即自动路由。
  文本推理覆盖裁判场景（transcript+usage → JSON）；视觉/音频模态仍需 transformers 全量路径。

## 实测驱动的加固（真实模型输出噪声）

1. `<think>` 推理段剥除（Qwen3 系模板默认输出，污染 JSON 解析；chat_template_kwargs 优先、正则兜底）
2. `_safe_float`：字符串数字提取（"4分"/"4/5"）+ dict 嵌套取 score/value
3. 量纲救援：六维全落 (0,1] 时 ×5（模型把 0-5 分输出成 0-1 小数）
4. verdict 枚举白名单（模型回显 "MVP|OBSERVE|FIRED" 字面量 → 回退 OBSERVE）
5. verdict 一致性护栏：与自身雷达均值矛盾时以雷达推导为准并留痕 evidence_trace
6. judge prompt 明确化（0-5 量纲 + verdict 三选一）

## 验证

- `/health` model_available=true（MOCK=false）
- `/api/evaluate-run` 多轮实测：事件序列完整（task_run → radar×6 → narration → audio(真实 TTS wav) → verdict → done），无 error
- 一致性护栏实测生效（FIRED→MVP 纠正 + 留痕）
- pytest 174 passed, 6 skipped

## 边界

- GGUF 路径仅文本模态；TTS 走系统命令（macOS say 已实测出 RIFF wav）
- Q4 量化 + 短 transcript 下模型评分仍有噪声，护栏只能挡矛盾不能提升判断质量
- NPU/transformers 全量路径仍未真机实测
