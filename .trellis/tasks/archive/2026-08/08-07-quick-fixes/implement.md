# implement.md — 08-07-quick-fixes

## 1. test:a11y 脚本（`package.json`）

- 原脚本指向 4 个测试文件，其中 `settings-center` / `activity-page` / `cron-page` 三个不存在（main 上也不存在）。
- grep `tests/unit` 下 axe（`vitest-axe` / `axe-core`）用法核实：仅 `tests/unit/workbench-empty-state.test.tsx` 一个 a11y 相关文件。
- 脚本改为 `vitest run tests/unit/workbench-empty-state.test.tsx`，实测 6 用例通过。

## 2. CI（新建 `.github/workflows/ci.yml`）

- 触发：push 到 `main` / `feat/*` + `pull_request`。
- `frontend` job：`pnpm/action-setup@v4`（按 packageManager 解析 pnpm 10）→ `setup-node@v4` node 22 + `cache: pnpm` → `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm lint:check` → `pnpm test`。
- `model-service` job：`setup-python@v5` 3.12 + pip cache（ keyed 到 requirements.txt）→ `pip install -r model-service/requirements.txt` + `httpx` → `cd model-service && python -m pytest tests/ -q`。
- 无部署/发布 job。用项目 node_modules 的 `yaml` 库解析校验通过（jobs / on / steps 结构正确）。

## 3. README 重写（`README.md`）

- 保留不动：§0 项目理念、§4 昇腾部署、真实模式安装（GGUF 路径 A / 全量权重路径 B）。
- §1 快速开始改为桌面端现实路径：`corepack pnpm install` → `corepack pnpm dev`（vite + vite-plugin-electron 拉起 Electron 窗口，非浏览器 Web Demo）；model-service 给出 Mock（`MOCK=true uvicorn`）与 GGUF 真实（`MOCK=false MODEL_PATH=models/MiniCPM-o-4_5-Q4_K_M.gguf uvicorn`）两条命令。
- §2 目录结构按真实仓库重写：electron 主进程（main/preload/api/gateway/services）、src（pages 18 个含 Evaluation/Interview/Marketplace、stores、engine、services、i18n、按域拆分的 types）、model-service（serve.py 装配 + app/routes 六路由域 + app/scoring）、tests/unit、.trellis；删除 pivot 前的 `src/types/index.ts` / `mockEvaluator` / `VITE_MOCK` 描述。
- §3 契约一节路径更新为 `src/types/`（evaluation.ts）↔ `app/schemas.py`，SSE 五事件不变，补 `/api/evaluate-run` 的 convergence/task_run 扩展事件（读 routes/evaluate.py 核实）。
- §5 测试一节更新为现实命令与实测数字：vitest 15 文件 / 300 用例、pytest 174 通过 / 6 跳过、i18n:check、test:a11y，并说明 CI 两道门禁。

## 4. i18n 缺口

- `zh/common.json` 与 `en/common.json` 的 `sidebar` 段补 `evaluation`（zh「评估中心」/ en「Evaluation」），照抄 marketplace/humanAssets 格式；`Sidebar.tsx:251` 的 defaultValue 由「绩效考核」对齐为「评估中心」。
- `common.json` 新增 `evaluation` 段（zh/en 双语，约 80 键）：panels 九项标签、表单 label/placeholder、会话下拉框、agent 卡片徽章（基线/已评估/未评估）、运行评估、雷达 hint、讲解/语音开关、dims 六维、lifecycle 五态 + 治理按钮、leaderboard 表头/tier、ROI 面板 hint/当量、dual（双轨卡 + 双榜）、preference（心智模型）。
- 改造文件（`useTranslation('common')` + `t(key, 'zh 默认')`，参考 Marketplace 页用法）：
  - `src/pages/Evaluation/index.tsx`（面板标签 `t(\`evaluation.panels.${key}\`)`、表单、空态、徽章、按钮、雷达/讲解面板文案；含插值的用 `defaultValue` + 变量形式，带样式的句子拆 pre/post 两键保住加粗 span）。
  - `src/pages/Evaluation/RadarChart.tsx`（dims + 序列名）、`RoiPanel.tsx`、`Leaderboard.tsx`（TIER_BADGE label 改按 tier 取 i18n 文案）。
  - `src/pages/Evaluation/LifecyclePanel.tsx`：**不再直接渲染 `strategyEngine.LIFECYCLE_LABELS`**，五态标签改走 `evaluation.lifecycle.states.*`；engine 层常量保留（非 UI 逻辑可用）。
  - 仅被 Evaluation 页消费的 `src/components/evaluation/DualTrackScoreCard.tsx` / `DualLeaderboard.tsx` / `PreferenceInsightPanel.tsx` 一并接入（dims 标签复用 `evaluation.dims.*`）。
- `i18n:check`（zh 基准 parity）通过。

## 5. 死代码删除

- grep 核实后删除：`src/services/githubImport.ts`、`src/utils/marketFilter.ts`（除互相引用外无页面/store/engine 消费）。
- **保留 `src/types/marketplace.ts`**：grep 证实它仍被 `stores/marketplace.ts`、`stores/interview.ts`、`types/interview.ts`、`engine/marketplace/*`、`components/marketplace/*`、`pages/Marketplace` 消费（main 已接入），与任务初始假设不同，以核实为准。
- 连带删除 `scripts/qa/github-import.qa.test.ts` 与 `scripts/qa/marketplace.qa.test.ts`：二者是被删模块的专属 QA 脚本，且 import pivot 前已删除的 `src/mock/`、`src/store/useAppStore.ts`，本就已损坏；不在 vitest include、tsconfig include、knip project 范围内。
- knip 前后对比：基线 50 个未使用文件，删后列表逐行 diff 完全一致，无新误报（两个死文件原本就不在 knip 报告里，因 scripts/qa 的 import 使其在图中可达）。

## 附带修复

- `zh/common.json` teamBrief 段的 `"openKanban"` 值为乱码「打\uFFFD\uFFFD\uFFFD看板」（文件内嵌 3 个 U+FFFD），修复为「打开看板」；不修会阻塞 Edit 锚点定位，且本身是 UI 可见 bug。

## 验证

- `corepack pnpm typecheck`：通过（tsc ×2 无输出）。
- `corepack pnpm lint:check`：0 error / 69 warning（存量 `no-explicit-any` 噪音）；改动文件单独 eslint 0 error，仅 2 条改前就存在的 exhaustive-deps warning（原代码同位置的 logical expression 依赖）。
- `corepack pnpm test`：15 文件 300 用例全绿。
- `corepack pnpm test:a11y`：6 用例通过。
- `corepack pnpm i18n:check`：`Locale parity OK across en, zh (9 namespaces)`。
- CI yaml：node `yaml` 库解析通过（2 jobs、触发器、steps 结构正确）。
- 附加确认：`cd model-service && .venv/bin/python -m pytest tests/ -q` → 174 passed / 6 skipped（CI 第二条门禁本地等价验证）；`corepack pnpm knip` 前后输出一致。

## 遗留

- `src/components/evaluation/SubjectiveScorePanel.tsx` 与 `ConvergenceTrajectoryWidget.tsx` 与 Interview 页共享，本期未接 i18n（硬编码中文仍在），建议另开任务连同 Interview 页一起处理。
- `src/engine/strategyEngine.ts` 的 `LIFECYCLE_LABELS` 中文常量保留但 UI 已不再消费（types/lifecycle.ts 还有一份同名副本，属存量重复）。
- `scripts/qa/` 下其余 QA 脚本（engine / frontend.strip）未动，同样引用 pivot 前路径、不在任何门禁内。
- lint 69 条存量 warning 未处理（非本期目标）。
- 未 git commit / push（按要求）；archive 脚本 auto-commit 除外。
