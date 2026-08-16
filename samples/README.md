# 固定候选样本集（samples/）

本目录存放**固定候选样本集**，用于零配置复现评测结果（离线可复现基线）。

```
samples/
├── candidate-01/{ profile.json, demo.mp4, intro.wav, art-1.png, art-2.png, code.zip }
├── candidate-02/{ profile.json, demo.mp4, intro.wav, art-1.png, code.zip }
└── candidate-03/{ profile.json, demo.mp4, intro.wav, art-1.png, code.zip }
```

## ⚠️ 真实媒体放置说明

当前仓库内的 `demo.mp4 / intro.wav / art-*.png / code.zip` 为**极小占位文件**（文本说明），
仅用于保留目录结构与 URL 引用。**真实部署**时，请将真实多模态二进制替换为同名文件：

- `demo.mp4`：候选短视频 demo（≤30s）
- `intro.wav`：候选语音自述（≤30s）
- `art-*.png`：作品图
- `code.zip`：代码库压缩包

> 演示环境（Mock 模式 / 无 NPU）完全不依赖这些媒体文件：
> 前端 `MediaViewer` 在媒体缺失时优雅降级为占位卡片，
> 评估事件流由 `src/mock/samples.ts` 的内联 fixture 生成，评委无 NPU 也能看完整 UI 与四模态闭环。

## profile.json 结构

严格遵循 `CandidateProfile`（见 `src/types/index.ts` 与 `model-service/app/schemas.py`）。
`media url` 指向同目录文件（相对 Web 根 `/samples/...`）。

Backend `/api/samples` 会读取本目录下各 `profile.json` 返回候选清单。
