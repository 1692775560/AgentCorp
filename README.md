# AgentCorp · MiniCPM-o 4.5 全模态 HR 总监

> 华为昇腾挑战赛 · 创新应用赛道（赛道二）指定模型 **MiniCPM-o 4.5（全模态）**
> 以全模态评估力统一消费候选 agent 的异质证据（视频/语音/图像/代码/文本），
> 产出六维能力雷达与用户契合度，并以语音辅佐筛选、语音宣判 MVP / 待观察 / You are fired。

---

## 0. 项目理念：人在回路，让「Agent 选择困难症」成为人机协同的起点

AgentCorp 不把大模型当「更聪明的搜索引擎」，而是把评估层做成**人在回路（human-in-the-loop）**的协奏场：

- **机器**负责可量化的客观基准——ROI、思考时延、任务返工率、六维能力雷达、工种专属 craft 维；
- **人**保留对审美倾向、任务理解「手感」、信任度等**非清晰规则**的主观赋分权，并随时可拖拽重排、把偏好回灌给下一次打分。

我们相信：**Agent 选择困难症**（面对海量候选 agent 该信谁）恰恰是挖掘「人机协调与同步」的最佳入口——它把模糊的方向性需求，经**梯度下降式收敛**为可检验、可迭代的工程问题。当人始终在环中，agent 就不会越过人直接抓取结果、退化成「猜你喜欢」；人也不再迷失在发散的状态空间里。

**学术价值**：AgentCorp 把「人机精准匹配与同步」做成可测量、可复现的实验对象，为 **人人 → 人机 → 人机人机** 的社会学演进提供可观测样本：评估数据（客观遥测 + 主观偏好）天然构成人机协同的研究语料，而偏好回灌回路则是「人机同步」的可计算原型。

---

## 1. 快速开始（Mock 模式，评委无 NPU 也能一键演示）

> 默认 `.env` 已设置 `VITE_MOCK=true`，无需任何 NPU 或真实媒体即可完整演示四模态闭环。

```bash
# 1) 安装依赖
pnpm install

# 2) 启动前端（默认 Mock 模式）
pnpm dev
```

打开浏览器访问 `http://localhost:5173`：

1. 顶部「固定样本集」选择候选（琳达 / 老张 / 阿强）。
2. 左侧查看多模态简历（无真实媒体时优雅降级为占位卡片）。
3. 右侧「用户偏好」可用**语音**或表单录入（审美 / 预算 / 技术栈 / 六维权重）。
4. 点击「开始评估」→ 六维雷达**逐维点亮** → 模型语音讲解（浏览器 TTS）+ 文本滚动 → 语音宣判 → 匹配度大数字 + 证据留痕。
5. 底部候选列表按 **user_fit 降序**实时重排。

> 四模态闭环在 Mock 模式由内联 fixture 驱动：看/读/听在真实模式真实发生，Mock 用浏览器 `speechSynthesis` 补「说」。

---

## 2. 目录结构

```
agentcorp/
├── docs/                      # PRD / 架构 / 类图 / 时序图
├── package.json / vite.config.ts / tailwind.config.js / tsconfig*.json
├── index.html / .env / .env.example
├── samples/                   # 固定候选样本集（profile.json + 占位媒体）
├── src/
│   ├── types/index.ts         # ★ 前后端契约单一真相源
│   ├── config.ts              # 环境配置（API base / Mock 开关）
│   ├── store/useAppStore.ts   # Zustand 全局状态
│   ├── data/samples.ts        # 样本清单加载
│   ├── mock/samples.ts        # Mock 评估 fixture（内联，无需 NPU）
│   ├── utils/radar.ts         # user_fit 计算（与后端镜像）
│   ├── utils/format.ts        # 格式化辅助
│   ├── services/              # api.ts（真实 SSE）/ mockEvaluator.ts（Mock）
│   ├── hooks/                 # useEvaluation / useUserPreference / useSpeech
│   └── components/            # Toolbar / CandidateProfilePanel / MediaViewer /
│                              #   RadarChart / FitScore / NarrationPanel /
│                              #   PreferenceInput / CandidateList / UploadModal
└── model-service/             # MiniCPM-o 推理服务（Python + FastAPI + SSE）
    ├── requirements.txt / Dockerfile / docker-compose.yml
    ├── tests/test_evaluate.py # 契约 + user_fit 测试（不依赖真模型）
    └── app/
        ├── serve.py           # FastAPI 入口（/api/samples, /api/evaluate, /api/upload）
        ├── schemas.py         # Pydantic 契约（与前端 types 镜像）
        ├── config.py          # 环境变量配置
        ├── model_loader.py    # MiniCPM-o 加载到 NPU（优雅降级）
        ├── evaluator.py       # 跨模态评估 pipeline + 可测试 Mock 流
        ├── prompt_templates.py# 强制六维 JSON 的系统提示
        └── tts.py             # 语音合成统一接口
```

---

## 3. 前后端契约（解耦关键）

前端 `src/types/index.ts` 与后端 `model-service/app/schemas.py` **严格镜像**。

- 请求：`EvaluationRequest { candidate, preference, options? }`
- SSE 事件流（`text/event-stream`）五种事件：
  - `radar_update`：逐维点亮（dim / score / confidence / evidence）
  - `narration`：讲解文本增量（delta / is_final）
  - `audio`：语音块（chunk 为 base64；真实=PCM16/wav 字节，Mock=UTF-8 文本）
  - `verdict`：终审判定（verdict / user_fit / evidence_trace / confidence）
  - `done`：评估完成（evaluation_id）

---

## 4. 昇腾真实部署（接入真实 MiniCPM-o）

```bash
# 1) 准备昇腾环境（CANN / torch_npu / MindIE 版本以官方公告为准）
# 2) 拉取 MiniCPM-o 4.5 权重（OpenBMB 官方 Ascend 适配版）
# 3) 构建并启动模型服务
cd model-service
docker compose up --build        # 默认 MOCK=true
# 真实推理：编辑 docker-compose.yml 设 MOCK=false 并透传 NPU 设备（/dev/davinci*）

# 4) 前端切真实模式
#    .env => VITE_MOCK=false   VITE_API_BASE=http://<npu-host>:8000
pnpm dev
```

无 NPU 时若 `MOCK=false` 且模型不可用，`/api/evaluate` 返回 `503` 并给出明确错误，不会静默崩溃。

### 本地运行模型服务（无需 Docker）

```bash
cd model-service
pip install -r requirements.txt
MOCK=true uvicorn app.serve:app --port 8000
# 访问 http://localhost:8000/docs 查看接口；/health 查看模型可用性
```

### 真实模式安装（MOCK=false，可选推理依赖）

真实推理依赖不进 `requirements.txt` 硬依赖（体积大、需匹配 CANN 版本），按需安装。

**路径 A · 端侧 GGUF（推荐评委机/笔记本，CPU/Metal 即可，无需 torch/transformers）**：

```bash
pip install llama-cpp-python
# macOS 建议启用 Metal 加速：
# CMAKE_ARGS="-DGGML_METAL=on" pip install llama-cpp-python

# 下载 GGUF 权重（Q4_K_M 约 5.4GB；ModelScope 国内更快）
mkdir -p models && curl -L -o models/MiniCPM-o-4_5-Q4_K_M.gguf \
  "https://modelscope.cn/models/OpenBMB/MiniCPM-o-4_5-gguf/resolve/master/MiniCPM-o-4_5-Q4_K_M.gguf"

# 启动（MODEL_PATH 指向 .gguf 文件即自动走 llama.cpp 后端）
MOCK=false MODEL_PATH=models/MiniCPM-o-4_5-Q4_K_M.gguf uvicorn app.serve:app --port 8000
# /health 返回 model_available=true 即真实裁判就绪
# 注：GGUF 路径仅文本推理（裁判场景够用）；视觉/音频模态需路径 B
```

**路径 B · 全量权重（GPU / 昇腾 NPU）**：

```bash
# GPU / CPU 环境（MiniCPM-o 4.5 官方基线，建议 Python 3.10/3.11）
pip install "transformers==4.51.0" accelerate "torch>=2.3.0,<=2.8.0" \
    "torchaudio<=2.8.0" "minicpmo-utils[all]>=1.0.5" librosa opencv-python

# 昇腾 NPU 环境：另装与 CANN 9.1.0 匹配的 torch_npu（或 FlagOS flag_gems），
# 版本矩阵见 docs/ascend-adaptation-plan.md §3；权重获取见 §4.1

# 启动（设备选择 NPU > CUDA > CPU 自动降级；DEVICE=npu|cuda|cpu|auto 可显式指定）
MOCK=false DEVICE=npu MODEL_PATH=/models/MiniCPM-o-4.5 uvicorn app.serve:app --port 8000
# /health 返回 model_available=true 即真实路径就绪
# TTS：优先模型原生（init_tts），其次系统命令（macOS say / Linux espeak-ng），
# 都没有则只发文本不发 audio 事件；TTS_BACKEND=auto|model|system|none 可控制
```

缺依赖 / 缺权重 / 无可用设备时服务照常启动，`/health` 报 `model_available=false`，
`/api/evaluate` 在真实模式下返回 503 明确错误，绝不 ImportError 崩溃。

---

## 5. 测试（模型服务，不依赖真模型）

```bash
cd model-service
pip install pytest
MOCK=true python -m pytest tests/ -q
```

覆盖：user_fit 满分/超预算硬约束/审美减分、模型 JSON 解析、SSE 事件流 schema（六维逐维点亮 / verdict / done）、未知候选兜底。

---

## 6. 说明与边界（诚实边界，PRD §13）

- Mock 模式完全不依赖 NPU 或真实媒体，评委离线即可看完整 UI 与四模态闭环演示。
- 真实媒体二进制请于昇腾部署时置入 `samples/candidate-XX/`（见 `samples/README.md`）。
- 对「单次小任务 + 单一已知 agent」，本 HR 评估层是 overhead，不提高生产力——这是产品的诚实边界。
- 评估结论可解释、过程留痕（evidence_trace），支持人工抽检，缓解元评估风险（R1/R3）。
