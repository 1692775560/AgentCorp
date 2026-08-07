# implement.md — 08-07-honest-eval-data

## 问题 1：fallbackMock 六维失真（`src/services/judgeClient.ts`）

- 删除 `usageToTelemetry()`（原伪造全成功遥测的源头）。
- `JudgeRunInput` 新增可选 `telemetry?: TelemetryEvent[]`（仅加法；后端 pydantic 无 `extra="forbid"`，未知字段被忽略，与既有 `convergence` 字段同先例）。
- `fallbackMock` 重写雷达派生：
  - cost 维：保留原有真实 usage 成本折算 `clamp(5 - totalCost/1.0*5, 0, 5)`。
  - `input.telemetry` 非空 → 原 `computeKpi` 客观 KPI 路径（五维公式不变）。
  - 遥测退化 → 新增 `hashAgentId()`（FNV-1a 32bit，渲染层无 node:crypto，自包含可复现）+ `jitter()`（base + [0,2)，对齐 `model-service/app/evaluator.py:_derive_run_radar` 的 base：task/quality/reliability=3.0、comm/creativity=2.5，shift 0/3/6/9/12）。
- evidence 诚实化：radar_update 按路径标注（"客观 KPI 归一化" / "真实 usage 成本折算" / "由 agentId 哈希派生"）；verdict evidence_trace 哈希路径给 `total_cost / avg_radar / source=mock`（对齐 Python mock）。
- verdict 判定逻辑不变（avg ≥4 MVP / ≥2.5 OBSERVE / 否则 FIRED），哈希派生使 FIRED 真实可达。

## 问题 2：user_fit / evidence_trace 落地

- `src/types/evaluation.ts`：`EvaluationProfile` 新增可选 `userFitLatest?: number`、`evidenceTraceLatest?: string[]`（向后兼容存量落库）。
- `src/stores/evaluation.ts runEvaluation`：verdict 事件增捕 `evidence_trace`；画像落库 `userFitLatest/evidenceTraceLatest`（无 verdict 时沿用 prev）。
- `computeLeaderboard` 的 `user_fit`：`Math.round(profile.userFitLatest ?? radarLatest.task*20)`，注释标注回退为历史近似。
- `src/pages/Evaluation/Leaderboard.tsx:54` 渲染 `LeaderboardEntry.user_fit`，来源修复后自动正确，UI 无改动。

## 问题 3：roi_norm 接通

- `runEvaluation` 第 4 步：以其余 profile 的 roi 数组作 `population` 传入 `buildRoiSnapshot`（空则不传，避免单 agent 时 roi_norm 落 0 误导），落库快照带真实 z-score（RoiPanel 同步受益）。
- `computeLeaderboard`（runLeaderboard 统一重算点）：当前全部 profile 的 roi 数组经 `roiEngine.zscore` 重算每条目 `roi_norm`。
  - 未重调 `buildRoiSnapshot` 的原因：entries/telemetry 不留存于画像，且 `computeRoi` 内 `roi_norm = zscore(population, roi)` 仅依赖 population 与 roi，直接 zscore 是同一计算。
  - 群体 ≥2 排序 roi_norm 优先（与裸 roi 排序数学等价但语义诚实）；单 agent z-score 恒 0 无区分度，回退裸 roi，注释说明。

## 测试（`tests/unit/judgeClient.test.ts`）

- 保留：确定性（同输入→同分数）、cost 维单调断言，语义不变。
- 新增 3 例：
  - "不同 agentId → 不同雷达"（且六维不再全钉 5）。
  - "FIRED 可达"：`agent-fired-2663`（用实现同款 FNV-1a+jitter 预计算，cost=0 时五维均值 ≈2.47 < 2.5）。
  - "真实遥测走 KPI 路径"：2/4 成功 → task=2.5，evidence 含 `task_completion_rate=50%`。
- `makeInput` 扩展 agentId/telemetry 参数，新增 `makeTelemetry` 辅助。

## 附带修复

- `eslint.config.js` ignores 增加 `build/**`：本地构建产物（git-ignored）内 js 文件的 eslint-disable 指令引用未加载规则，产生 84 个 "rule not found" error，与本次改动无关但阻塞 lint:check 验收。

## 验证

- `corepack pnpm typecheck`：通过（tsc ×2 无输出）。
- `corepack pnpm lint:check`：0 error / 69 warning（warning 为存量 `any` 风格噪音，不阻塞）。
- `corepack pnpm test`：15 文件 300 用例全绿；judgeClient 8 用例通过（含 3 新增）。

## 遗留

- 哈希路径五维 base 均 ≥2.5，MVP 需 cost 维高分配合（avg≥4），可达但偏保守；与 Python 侧行为一致，未额外调参。
- 落库 `roi_norm`（评估时群体，不含自己）与 Leaderboard 展示值（当前全体，含自己）参考群体略不同，均为真实 z-score；如需严格一致可在后续统一。
- 未 git commit（按要求）；archive 脚本 auto-commit 除外。
