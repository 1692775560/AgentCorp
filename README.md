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

## 1. 快速开始

### 1.1 桌面端（Electron + React）

```bash
# 1) 安装依赖（pnpm 由 corepack 提供，版本锁定在 package.json 的 packageManager）
corepack pnpm install

# 2) 启动桌面端（vite dev server + vite-plugin-electron 自动拉起 Electron 主进程）
corepack pnpm dev
```

`pnpm dev` 会同时启动渲染层（Vite）与 Electron 主进程（`electron/main/index.ts`），
产出桌面窗口而非纯浏览器页面。主要页面：人才市集（Marketplace，S1 初审）→
HR 面试（Interview，S2）→ 评估中心（Evaluation，S3 绩效：雷达 / 讲解 / ROI /
生命周期 / 擂台 / 双轨评分 / 双榜 / 收敛 / 心智模型），外加任务看板、人力资产、
团队总览等管理页。

### 1.2 模型服务（MiniCPM-o 裁判，Python + FastAPI + SSE）

评估中心的「运行评估」需要模型服务。两种启动方式：

```bash
cd model-service
pip install -r requirements.txt

# Mock 模式：不加载真模型，内联 fixture 驱动完整 SSE 事件流（演示/联调用）
MOCK=true uvicorn app.serve:app --port 8000

# GGUF 真实模式：端侧 llama.cpp 文本推理（CPU/Metal 即可，需先按下文路径 A 装好权重）
MOCK=false MODEL_PATH=models/MiniCPM-o-4_5-Q4_K_M.gguf uvicorn app.serve:app --port 8000
```

访问 `http://localhost:8000/docs` 查看接口；`/health` 查看模型可用性
（真实模式下 `model_available=true` 即裁判就绪）。

---

## 2. 目录结构

```
agentcorp/
├── docs/                      # PRD / 架构 / 类图 / 时序图
├── package.json / vite.config.ts / vitest.config.ts / tailwind.config.js / tsconfig*.json
├── electron/                  # Electron 主进程与 preload
│   ├── main/                  # 主进程入口（窗口、生命周期）
│   ├── preload/               # preload 桥（contextBridge）
│   ├── api/ gateway/ services/ shared/ utils/
├── shared/                    # 主进程与渲染层共享代码
├── samples/                   # 固定候选样本集（profile.json + 占位媒体）
├── scripts/                   # 构建/打包/QA/i18n 工具脚本（含 i18n/check-parity.mjs）
├── tests/unit/                # vitest 单元测试（jsdom + node 双环境）
├── .trellis/                  # Trellis 任务工作流（tasks/ + scripts/task.py）
├── src/                       # 渲染层（React 19 + TS + Tailwind）
│   ├── pages/                 # 18 个页面：Chat / Marketplace / Interview / Evaluation /
│   │                          #   Kanban / TeamOverview / TeamMap / Agents / Settings 等
│   ├── components/            # layout / evaluation / marketplace / interview / ui 等
│   ├── stores/                # Zustand 全局状态（agents / evaluation / marketplace / ...）
│   ├── engine/                # 纯逻辑层：strategyEngine / roiEngine / metricsEngine /
│   │                          #   scoring / marketplace / interview / convergence
│   ├── services/              # 运行时服务：evaluationRuntime / judgeClient / speech / ...
│   ├── i18n/                  # react-i18next（zh 基准 + en，common 等 9 个 namespace）
│   ├── hooks/  lib/  styles/  utils/
│   └── types/                 # 前端契约类型（按域拆分：evaluation / marketplace / ...）
└── model-service/             # MiniCPM-o 推理服务（Python + FastAPI + SSE）
    ├── requirements.txt / Dockerfile / docker-compose.yml
    ├── models/                # GGUF 权重（如 MiniCPM-o-4_5-Q4_K_M.gguf，自行下载）
    ├── tests/                 # pytest（契约 + 评分 + 收敛 + GGUF 后端，不依赖真模型）
    └── app/
        ├── serve.py           # FastAPI 入口（只做装配，挂 6 个路由域）
        ├── routes/            # 模块化路由：samples / evaluate / upload /
        │                      #   convergence / leaderboard / health
        ├── scoring/           # 三阶段评分：registry / rules_engine / stage_scorer /
        │                      #   presets / convergence / preference / encoder / task_sets
        ├── schemas.py         # Pydantic 契约（与前端 src/types/ 镜像）
        ├── config.py          # 环境变量配置（MOCK / MODEL_PATH / DEVICE / TTS_BACKEND）
        ├── model_loader.py    # MiniCPM-o 加载（GGUF / 全量权重，优雅降级）
        ├── evaluator.py       # 跨模态评估 pipeline + 可测试 Mock 流
        ├── prompt_templates.py# 强制六维 JSON 的系统提示
        └── tts.py             # 语音合成统一接口
```

---

## 3. 前后端契约（解耦关键）

前端 `src/types/`（按域拆分，评估相关在 `evaluation.ts`）与后端
`model-service/app/schemas.py` **严格镜像**。

- 请求：`EvaluationRequest { candidate, preference, options? }`
- SSE 事件流（`text/event-stream`）五种事件：
  - `radar_update`：逐维点亮（dim / score / confidence / evidence）
  - `narration`：讲解文本增量（delta / is_final）
  - `audio`：语音块（chunk 为 base64；真实=PCM16/wav 字节，Mock=UTF-8 文本）
  - `verdict`：终审判定（verdict / user_fit / evidence_trace / confidence）
  - `done`：评估完成（evaluation_id）
- 评估运行（`/api/evaluate-run`）在同构事件流上扩展 `convergence_update` /
  `task_run` / `convergence_score` 事件（Task-Set 调度 + Layer3 收敛）。

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

## 5. 测试

前端（vitest，`tests/unit/`，15 个文件 / 300 条用例，不依赖 Electron 与真模型）：

```bash
corepack pnpm test          # 全量单元测试
corepack pnpm test:a11y     # a11y（axe）专项
corepack pnpm typecheck     # TS 双 tsconfig 类型检查
corepack pnpm lint:check    # eslint
corepack pnpm i18n:check    # zh/en 语言包 key parity
```

模型服务（pytest，`model-service/tests/`，174 通过 / 6 跳过，不依赖真模型）：

```bash
cd model-service
pip install -r requirements.txt
MOCK=true python -m pytest tests/ -q
```

覆盖：user_fit 满分/超预算硬约束/审美减分、模型 JSON 解析、SSE 事件流 schema
（六维逐维点亮 / verdict / done）、三阶段评分（S1/S2/S3 rules engine）、
Layer3 收敛（encoder / preference / convergence）、GGUF 后端降级、未知候选兜底。

CI（`.github/workflows/ci.yml`）：push 到 `main` / `feat/*` 与 PR 触发，
前端 job 跑 install → typecheck → lint → test，model-service job 跑 pytest。

---

## 6. 说明与边界（诚实边界，PRD §13）

- Mock 模式完全不依赖 NPU 或真实媒体，评委离线即可看完整 UI 与四模态闭环演示。
- 真实媒体二进制请于昇腾部署时置入 `samples/candidate-XX/`（见 `samples/README.md`）。
- 对「单次小任务 + 单一已知 agent」，本 HR 评估层是 overhead，不提高生产力——这是产品的诚实边界。
- 评估结论可解释、过程留痕（evidence_trace），支持人工抽检，缓解元评估风险（R1/R3）。
