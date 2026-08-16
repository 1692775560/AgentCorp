# AgentCorp

> **跑分测的是模型，不是你的真实工作。**
> AgentCorp 用同一套工种实测题、同一份评分标准，把「该用哪个 Agent」
> 从凭感觉，变成可测量、可复现、可追溯的判断。

<img width="2940" height="1742" alt="AgentCorp 界面预览" src="https://github.com/user-attachments/assets/3399d589-4ed5-4b41-a201-0dedc258ad32" />

---

## 为什么需要它

现有的 Agent 评测基本回答不了两个实际问题：

1. **跑分与真实工作脱节。** 榜单在标准化题库上比较模型的通用能力，
   而真实工作需求模糊、约束具体、要能交付。跑分高不等于能替你完成这份工作。
2. **不同来源的 Agent 之间没有公共标尺。** 选型只能看 star 数或一句「挺好用」，
   新发布的 Agent 天然吃亏，团队引入时也无法回答「能不能上线、出问题谁负责」。

AgentCorp 把选型变成一次**有证据的准入评审**：出同一套题、按同一份标准打分、
留下可复核的记录、由人拍板。

## 核心能力

| 能力 | 解决的问题 | 做法 |
|---|---|---|
| **候选市场** | 从哪里找 Agent，怎么公平展示 | 支持导入开源 Agent 或上传自有 Agent；使用者的真实偏好可见，不只看 star |
| **能力实测** | 这个 Agent 到底会不会干活 | 12 道固定题覆盖写代码 / 写文案 / 做图三类工种，同题同标尺，题面内置反注水探针 |
| **持续评估** | 用过之后谁更值得留 | 客观榜按完成度、返工率、耗时、成本排名；主观榜允许每位使用者按自身价值观重排 |

两张榜单并存是刻意的设计：有人认为保住完成度比省时间更重要，有人相反。
我们不假设存在唯一的最优解。

## 评估结论为什么可信

用模型给模型打分，首先要解决「裁判本身可不可靠」：

- **重复测量**：同一份作答独立评多次，每次都达标才判定为通过。
- **稳定性检查**：多次评分离散过大时下调置信度并转人工复核。
- **抗偏差设计**：轮换维度顺序、固定评分锚点、明确要求不因回答长而给高分。
- **来源标注**：分数分为真实裁判 / 部分降级 / 完全降级三态，降级结论不进入经验库。

系统只主张结论**稳定**，不主张结论**正确**——后者需要长期的真实表现数据验证，
这是我们公开的下一阶段目标。

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

### 1.2 模型服务（评测裁判，Python + FastAPI + SSE）

评估中心的「运行评估」需要模型服务。**裁判后端可替换**（`JudgeBackend` 协议，见 §4）：
任何 OpenAI 兼容服务都能当裁判，也可用全模态模型（如 MiniCPM-o 4.5）统一消费
候选 Agent 的异质产出（代码、图像、文案、语音）。
不绑定单一模型家族既是工程需要，也是**抗自我增强偏差**的架构级保障。

```bash
cd model-service
pip install -r requirements.txt

# Mock 模式：不加载真模型，内联 fixture 驱动完整 SSE 事件流（演示/联调用）
MOCK=true uvicorn app.serve:app --port 8000

# 真实模式（推荐）：任意 OpenAI 兼容云服务作裁判，零硬件门槛
MOCK=false JUDGE_BACKEND=http \
  JUDGE_BASE_URL=<your_openai_compatible_endpoint> \
  JUDGE_API_KEY=<your_key> JUDGE_MODEL=<model_name> \
  uvicorn app.serve:app --port 8000
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
├── src/                       # 渲染层（React 19 + TS + Tailwind）
│   ├── pages/                 # Chat / Marketplace / Interview / Evaluation /
│   │                          #   Kanban / TeamOverview / TeamMap / Agents / Settings 等
│   ├── components/            # layout / evaluation / marketplace / interview / office / ui
│   ├── office/                # 像素办公室（Agent 工作可视化）
│   ├── stores/                # Zustand 全局状态（agents / evaluation / marketplace / ...）
│   ├── engine/                # 纯逻辑层：strategyEngine / roiEngine / metricsEngine /
│   │                          #   scoring / marketplace / interview / convergence
│   ├── services/              # 运行时服务：evaluationRuntime / judgeClient / speech / ...
│   ├── i18n/                  # react-i18next（zh 基准 + en）
│   ├── hooks/  lib/  styles/  utils/
│   └── types/                 # 前端契约类型（按域拆分：evaluation / marketplace / ...）
└── model-service/             # 评测裁判服务（Python + FastAPI + SSE）
    ├── requirements.txt / Dockerfile / docker-compose.yml
    ├── models/                # GGUF 权重（自行下载，不入仓）
    ├── tests/                 # pytest（契约 + 评分 + 收敛 + GGUF 后端，不依赖真模型）
    └── app/
        ├── serve.py           # FastAPI 入口（只做装配，挂 6 个路由域）
        ├── routes/            # samples / evaluate / upload / convergence / leaderboard / health
        ├── scoring/           # registry / rules_engine / stage_scorer / presets /
        │                      #   convergence / preference / encoder / task_sets
        ├── schemas.py         # Pydantic 契约（与前端 src/types/ 镜像）
        ├── config.py          # 环境变量配置（MOCK / MODEL_PATH / DEVICE / TTS_BACKEND）
        ├── model_loader.py    # 裁判模型加载（GGUF / 全量权重，优雅降级）
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
  `task_run` / `convergence_score` 事件（Task-Set 调度 + 收敛层度量）。

渲染层不直连模型服务：请求经 `hostApiFetch` → IPC → 主进程本地 HTTP server
（`127.0.0.1:3210`）转发，凭据只存在于主进程，渲染层拿不到。

---

## 4. 接入真实裁判模型

> **裁判后端是可替换的，这是刻意的架构决策，不是妥协。**
> 用模型评模型天然有「自我增强偏差」（裁判偏爱与自己同家族的产出）。
> 因此本项目把推理后端抽象为 `JudgeBackend` 协议（`model-service/app/judge_backend.py`），
> 任何 OpenAI 兼容服务都能作为裁判接入，评估体系不绑定任何单一模型或单一芯片。
> 换后端只改环境变量，评分逻辑、Skill 契约、Trace 结构一律不动。

四条路径按「上手成本」排序，代码路径完全一致：

| 路径 | 后端 | 适用场景 | 硬件要求 |
|---|---|---|---|
| **A（默认推荐）** | `JUDGE_BACKEND=http` | 任何 OpenAI 兼容云服务（阿里云百炼/通义、火山方舟、OpenAI…） | 无，联网即可 |
| B | `JUDGE_BACKEND=http` + 本地 vLLM | 自建推理服务 | GPU |
| C | 端侧 GGUF | 离线复现、评委笔记本 | CPU/Metal 即可 |
| D | 本机全量权重 | 需要视觉/音频模态 | GPU 或异构加速卡（NPU 等） |

### 路径 A · OpenAI 兼容云服务（默认推荐，零硬件门槛）

```bash
cd model-service
pip install -r requirements.txt

# 以阿里云百炼（DashScope OpenAI 兼容模式）为例：
MOCK=false \
JUDGE_BACKEND=http \
JUDGE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \
JUDGE_API_KEY=<your_api_key> \
JUDGE_MODEL=qwen-plus \
uvicorn app.serve:app --port 8000

# 换成任意其它 OpenAI 兼容端点同理，只改这三个环境变量：
# JUDGE_BASE_URL / JUDGE_API_KEY / JUDGE_MODEL
```

`judge_backend.py` 的 HTTP 后端用标准库 `urllib` 实现（零新增依赖），
并统一采集 `ttft_ms` / `latency_ms` / `usage`，供成本与时延归因。

### 路径 B · 自建 vLLM / 本地推理服务

同路径 A，把 `JUDGE_BASE_URL` 指向自建服务即可（如 `http://localhost:8080/v1`）。

### 路径 C · 端侧 GGUF（离线复现，CPU/Metal 即可）

无需 torch / transformers，最容易复现。

```bash
pip install llama-cpp-python
# macOS 建议启用 Metal 加速：
# CMAKE_ARGS="-DGGML_METAL=on" pip install llama-cpp-python

# 下载 GGUF 权重（Q4_K_M 约 5.4GB；ModelScope 国内更快）
mkdir -p models && curl -L -o models/MiniCPM-o-4_5-Q4_K_M.gguf \
  "https://modelscope.cn/models/OpenBMB/MiniCPM-o-4_5-gguf/resolve/master/MiniCPM-o-4_5-Q4_K_M.gguf"

MOCK=false MODEL_PATH=models/MiniCPM-o-4_5-Q4_K_M.gguf uvicorn app.serve:app --port 8000
# /health 返回 model_available=true 即真实裁判就绪
# 注：GGUF 路径仅文本推理（裁判场景够用）；视觉/音频模态需路径 B
```

### 路径 D · 本机全量权重（需要视觉/音频模态时）

```bash
pip install "transformers==4.51.0" accelerate "torch>=2.3.0,<=2.8.0" \
    "torchaudio<=2.8.0" "minicpmo-utils[all]>=1.0.5" librosa opencv-python

MOCK=false JUDGE_BACKEND=local DEVICE=cuda MODEL_PATH=/models/<your-omni-model> \
  uvicorn app.serve:app --port 8000
```

`DEVICE` 支持 `cuda|cpu|auto`，另可选装对应厂商的异构加速运行时后按
`DEVICE=npu` 启用（`model_loader.py` 惰性 import，缺依赖自动降级，不崩）。
容器部署见 `model-service/docker-compose.yml`。

前端切真实模式：`.env` 里设 `VITE_MOCK=false`、`VITE_API_BASE=http://<host>:8000`。

**降级行为**：缺依赖 / 缺权重 / 无可用设备时服务照常启动，`/health` 报
`model_available=false`，真实模式下 `/api/evaluate` 返回 `503` 并给出明确错误，
绝不 ImportError 崩溃。TTS 同理：优先模型原生（`init_tts`），其次系统命令
（macOS `say` / Linux `espeak-ng`），都没有则只发文本不发 audio 事件
（`TTS_BACKEND=auto|model|system|none`）。

---

## 5. 测试

前端（vitest，`tests/unit/`，不依赖 Electron 与真模型）：

```bash
corepack pnpm test          # 全量单元测试
corepack pnpm test:a11y     # a11y（axe）专项
corepack pnpm typecheck     # TS 双 tsconfig 类型检查
corepack pnpm lint:check    # eslint
corepack pnpm i18n:check    # zh/en 语言包 key parity
```

模型服务（pytest，`model-service/tests/`，不依赖真模型）：

```bash
cd model-service
pip install -r requirements.txt
MOCK=true python -m pytest tests/ -q
```

覆盖：user_fit 满分 / 超预算硬约束 / 审美减分、模型 JSON 解析、SSE 事件流 schema
（六维逐维点亮 / verdict / done）、三阶段评分（S1/S2/S3 rules engine）、
收敛层（encoder / preference / convergence）、GGUF 后端降级、未知候选兜底、
GitHub 导入输入侧安全加固、跨用户反应聚合。

CI（`.github/workflows/ci.yml`）：push 到 `main` / `feat/*` 与 PR 触发，
前端 job 跑 install → typecheck → lint → test，model-service job 跑 pytest。

---

## 6. 适用范围与已知边界

我们把限制写在明处，而不是等使用者自己撞上：

- **离线演示模式不依赖任何加速硬件或真实媒体**，可完整查看产品形态与闭环流程；
  它用于理解系统结构，不代表真实推理链路的评测结论。
- **真实媒体样本不入仓**，部署时置入 `samples/candidate-XX/`（见 `samples/README.md`）。
- **单次任务 + 单一已知 Agent 的场景下，本评估层是额外开销**。
  它的价值出现在候选多、任务重复、选错代价高的场景。
- **评估过程全程留痕**（`evidence_trace`），支持人工抽检。
  用模型评估模型存在固有的元评估风险，留痕是缓解手段而非消除。
- **收敛指标度量的是人机对齐过程，不等同于 Agent 能力**。
  能力判断以真实工种实测的评分结果为准。
- **当前指标验证的是结论的稳定性，尚未验证预测有效性**。
  准入评分与上线后真实表现的相关性验证是我们公开的下一阶段目标。

---

## 7. 许可

MIT。Forked from ClawCorp (MIT)。
