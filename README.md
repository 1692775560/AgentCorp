# AgentCorp：Agent 适配与协同平台
   <img width="376" height="380" alt="e39900a59e427a887368dc6f694de7ea" src="https://github.com/user-attachments/assets/090ea2ca-fa0b-415c-849c-bd5aa8e93e21" />


> **LLM跑分测的是模型能力，却不是你的真实工作。**
> 面对日渐膨胀的Agent选择，你是否常常陷入到一种「Agent选择困难症」中？
> 面对日新月异的各种功能，什么样的数字员工最能够契合你真实的工作流程？
> 
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

AgentCorp 把选择变成一次**带证据的准入评审**：
出同一套题、按同一份标准打分、留下可复核的记录、最终由人拍板。

## 核心能力

| 能力 | 解决的问题 | 做法 |
|---|---|---|
| **候选市场** | 从哪里找 Agent，怎么公平展示 | 内置 285 个可雇佣的数字员工模板，支持上传自有 Agent；六维初审 + 任务画像匹配排序，使用者的真实偏好可见，不只看 star（GitHub 一键导入在路线图上，尚未实现） |
| **能力实测** | 这个 Agent 到底会不会干活 | 12 道固定题覆盖写代码 / 写文案 / 做图三类工种，同题同标尺，逐条 checkpoint 必须带原文引用，题面内置反注水探针（当前均为文本作答题：做图工种考的是「把模糊 brief 翻成可执行参数与提示词」，尚未接入真实出图评审） |
| **持续评估** | 用过之后谁更值得留 | 客观榜按完成度、返工率、耗时、成本排名；主观榜允许每位使用者按自身价值观重排 |

客观+主观的两张排名榜单并存是我们刻意的设计
也许有人认为保住任务完成度比省时间更重要，有人可能格外关注性价比。
因此，我们不假设某个单一的维度是最优解，而是将所有维度进行客观评估后，交由用户自行在主观榜单中排序自己心目中的最佳数字员工。
而AgentCorp则在用户的选择中更加明白什么样的数字员工匹配得上“老板”的喜好和需求。

## 评估结论为什么可信

如果我们用模型给模型打分，那么首先要解决「裁判本身可不可靠」：

- **重复测量**：同一份作答独立评多次，每次都达标才判定为通过。
- **稳定性检查**：多次评分离散过大时下调置信度并转人工复核。
- **抗偏差设计**：轮换维度顺序、固定评分锚点、明确要求不因回答长而给高分。
- **来源标注**：分数分为真实裁判 / 部分降级 / 完全降级三态。完全降级的条目
  **不进正式榜单**（单独灰色分区展示、不给名次），也不沉淀进经验库。

通过以上做法，AgentCorp系统目前只主张得出的结论是**稳定**的，但是暂时不主张结论是最**正确**的；而后者往往需要长期的真实表现数据验证，
这正是我们公开的下一阶段目标。

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
任何 OpenAI 兼容服务都能当裁判，也可用国内全模态模型（如 MiniCPM-o 4.5）统一推理评测
候选 Agent 的多模态产出（代码、图像、文案、语音）。
不绑定单一模型大厂既是我们工程上的需要，也是**抗自我增强偏差**的架构级保障。

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

`DEVICE` 默认 `auto`（按 NPU > CUDA > CPU 探测），支持 `cuda|cpu|auto`，另可选装对应厂商的异构加速运行时后按
`DEVICE=npu` 启用（`model_loader.py` 惰性 import，缺依赖自动降级，不崩）。
容器部署见 `model-service/docker-compose.yml`。

前端无需额外开关：渲染层不直连模型服务，请求统一经主进程 Host API
（`127.0.0.1:3210`）转发到 model-service。裁判是否为真，由 model-service 侧的
`JUDGE_BACKEND` 决定，并通过事件里的 `source`（judge / mixed / degraded）如实回传给界面。
全量环境变量见 `.env.example`。

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
Q6 降权闸门（requiresReal 维只认真实执行/扫描证据，裁判引文不作数）、
收敛层（encoder / preference / convergence）、GGUF 后端降级、未知候选兜底、
craft 试做题评分与越界维度丢弃、Arena 对决与 Elo、跨用户反应聚合。

前端侧另有诚实化回归：离线回退的分数**不得**与 agentId 相关（改名不能改分），
零证据时全维中性 2.5 并标注「不可评」（`tests/unit/judgeClient.test.ts`）。

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
- **代码工种的分数尚未经过真实执行验证**。`code_runnability` / `code_security`
  目前由裁判阅读答案判断，因此这两维在缺少真实执行/扫描结果时会被**主动降权 ×0.4**
  并在证据栏标注。接入沙盒执行（跑候选给出的测试）是我们的下一步，
  也是我们认为这套评测唯一能真正"落地为事实"的方向。
- **裁判与候选可能同源**。若 `JUDGE_MODEL` 与候选 agent 使用同一家族的模型，
  自我增强偏差无法通过架构消除。建议评测时显式选用与候选不同家族的裁判，
  并用双榜与人工抽检交叉验证。

---

## 7. 许可

MIT。Forked from ClawCorp (MIT)。
