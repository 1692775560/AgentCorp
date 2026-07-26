# AgentCorp · MiniCPM-o 4.5 全模态 HR 总监

> 华为昇腾挑战赛 · 创新应用赛道（赛道二）指定模型 **MiniCPM-o 4.5（全模态）**
> 以全模态评估力统一消费候选 agent 的异质证据（视频/语音/图像/代码/文本），
> 产出六维能力雷达与用户契合度，并以语音辅佐筛选、语音宣判 MVP / 待观察 / You are fired。

---

## 1. 快速开始（Mock 模式，评委无 NPU 也能一键演示）

> 默认 `.env` 已设置 `VITE_MOCK=true`，无需任何 NPU 或真实媒体即可完整演示四模态闭环。

```bash
# 1) 安装依赖
npm install

# 2) 启动前端（默认 Mock 模式）
npm run dev
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
npm run dev
```

无 NPU 时若 `MOCK=false` 且模型不可用，`/api/evaluate` 返回 `503` 并给出明确错误，不会静默崩溃。

### 本地运行模型服务（无需 Docker）

```bash
cd model-service
pip install -r requirements.txt
MOCK=true uvicorn app.serve:app --port 8000
# 访问 http://localhost:8000/docs 查看接口；/health 查看模型可用性
```

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
