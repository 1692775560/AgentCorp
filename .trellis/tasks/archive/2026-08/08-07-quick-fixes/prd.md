# 快修包圆：a11y 脚本 + CI + README + i18n 缺口 + 死代码

## Goal

在 `feat/review-fixes-and-eval-layer` 分支上完成五项相互独立的快修：修复失效的 `test:a11y` 脚本、补齐 CI 门禁、重写已过时的 README、补上 i18n 缺口（侧边栏 evaluation 键 + Evaluation 页硬编码中文）、删除确认无消费方的死代码。所有改动以「最小侵入、门禁全绿」为准绳。

## Requirements

### R1 · test:a11y 脚本修复（package.json）

- 现状：`test:a11y` 指向 4 个测试文件，其中 `settings-center` / `activity-page` / `cron-page` 三个不存在（main 上也不存在），直接运行报错。
- 要求：grep `tests/unit` 下实际含 axe（`vitest-axe` / `axe-core`）用法的文件，脚本只跑存在且与 a11y 相关的测试（核实结果：仅 `tests/unit/workbench-empty-state.test.tsx`）。
- 验收：`corepack pnpm test:a11y` 实测通过。

### R2 · CI 工作流（新建 .github/workflows/ci.yml）

- 触发：push 到 `main` / `feat/*`，以及 PR。
- Job 1（前端门禁，Node 22 + pnpm 10，对齐 package.json 的 `packageManager` 与 `@types/node ^25`）：
  1. `pnpm/action-setup` + pnpm store cache → `pnpm install`
  2. `pnpm typecheck`
  3. `pnpm lint:check`
  4. `pnpm test`
- Job 2（model-service，Python 3.12）：`pip install -r model-service/requirements.txt` + `httpx` → `cd model-service && python -m pytest tests/ -q`。
- 明确不写部署 / 发布 job。

### R3 · README 重写（README.md）

- 保留不动：§0 项目理念段、§4 昇腾部署段、§真实模式安装（GGUF 路径 A/B 已有内容）。
- 重写：
  - 目录结构：反映真实现状 —— Electron 桌面底座（`src/pages/` 含 Evaluation / Interview / Marketplace 等 18 个页面）+ `electron/` 主进程 + `model-service/`（`app/routes/` 模块化路由）+ `.trellis/` 工作流；删除 pivot 前 Web Demo 的描述（`src/types/index.ts`、`mockEvaluator`、`VITE_MOCK` 等均已不存在）。
  - 快速开始：`pnpm install` → `pnpm dev`（桌面端）；model-service 的 Mock 与 GGUF 真实模式两条启动命令（GGUF 例子用 `MODEL_PATH=models/MiniCPM-o-4_5-Q4_K_M.gguf`）。
  - 测试一节：更新为 vitest（`corepack pnpm test`）与 pytest（`cd model-service && python -m pytest tests/ -q`）的现实命令，测试数以实测为准。
- 写前必须读真实目录确认，不臆造路径。

### R4 · i18n 缺口

- R4a · 侧边栏：`src/i18n/locales/zh/common.json` 与 `en/common.json` 的 `sidebar` 段补 `evaluation` 键（zh「评估中心」/ en「Evaluation」）。`Sidebar.tsx:251` 引用的是 `common:sidebar.evaluation`（格式照抄已有的 `marketplace` / `humanAssets`）。
- R4b · Evaluation 页：`src/pages/Evaluation/`（index / RadarChart / RoiPanel / LifecyclePanel / Leaderboard）整页硬编码中文接入 i18n —— 面板标签（雷达/讲解/ROI/生命周期/擂台/双轨评分/双榜/收敛/心智模型）、运行评估按钮、表单 label 与 placeholder、空态文案、LifecycleDot 相关、会话下拉框选项、表头等用户可见字符串。common.json 新增 `evaluation` 段，zh/en 双语；用法参考 `src/pages/Marketplace/index.tsx` 的 `useTranslation('common')` + `t('key', '中文默认')` 模式。
- R4c · `LIFECYCLE_LABELS`（`src/engine/strategyEngine.ts:163`）被 `LifecyclePanel.tsx` 直接渲染：LifecyclePanel 改用 i18n 标签（常量本身保留在 engine 层，供非 UI 逻辑使用）。
- R4d · 仅被 Evaluation 页消费的 `src/components/evaluation/` 组件（DualTrackScoreCard / DualLeaderboard / PreferenceInsightPanel）一并接入；与 Interview 页共享的 SubjectiveScorePanel / ConvergenceTrajectoryWidget 本期不动，记为遗留。
- 验收：`corepack pnpm i18n:check`（scripts/i18n/check-parity.mjs，zh 为基准语言做 key parity 校验）通过。

### R5 · 死代码删除

- 删除 `src/services/githubImport.ts`（约 750 行）与 `src/utils/marketFilter.ts`：grep 核实二者互相引用之外无页面 / store / engine 消费。
- **保留 `src/types/marketplace.ts`**：grep 证实它仍被 `stores/marketplace.ts`、`stores/interview.ts`、`engine/marketplace/*`、`components/marketplace/*`、`pages/Marketplace`、`types/interview.ts` 消费（main 已接入），与任务初始假设不同，以核实结果为准。
- 连带删除 `scripts/qa/github-import.qa.test.ts` 与 `scripts/qa/marketplace.qa.test.ts`：二者是被删模块的专属 QA 脚本，且引用了 pivot 前已删除的 `src/mock/`、`src/store/useAppStore.ts`，本就已损坏（不在 vitest / tsconfig / knip 范围内）。
- 验收：`corepack pnpm knip` 前后对比，两个死文件消失且无新误报；typecheck / lint / test 不受影响。

## Acceptance Criteria

- [ ] `corepack pnpm test:a11y` 通过（只跑存在的 a11y 测试文件）
- [ ] `.github/workflows/ci.yml` 存在，两个 job 四条+一条门禁，YAML 语法校验通过
- [ ] README 目录结构 / 快速开始 / 测试三节与真实仓库一致，保留段未动
- [ ] `corepack pnpm i18n:check` 通过；zh/en common.json 均含 `sidebar.evaluation` 与 `evaluation` 段
- [ ] Evaluation 页（含 R4d 范围内组件）无用户可见硬编码中文
- [ ] `githubImport.ts` / `marketFilter.ts` 及两个专属 QA 脚本已删，`types/marketplace.ts` 保留
- [ ] `corepack pnpm typecheck` 通过
- [ ] `corepack pnpm lint:check` 0 error
- [ ] `corepack pnpm test` 全绿
- [ ] `corepack pnpm knip` 无新误报

## Out of Scope / Notes

- 不做 git commit / push（Trellis archive 脚本自身的 auto-commit 除外）。
- CI 不写部署 / 发布 job。
- 共享组件 SubjectiveScorePanel / ConvergenceTrajectoryWidget（Interview 页也在用）的 i18n 记为遗留，另开任务。
- `scripts/qa/` 下其余 QA 脚本（engine / frontend.strip）不在本期范围。
- 轻量任务，PRD-only，不另写 design.md。
