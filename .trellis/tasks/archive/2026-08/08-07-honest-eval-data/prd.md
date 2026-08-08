# 评估数据诚实化：Mock 六维失真修复 + verdict user_fit/证据落地 + roi_norm 接通

## Goal

消除评审确认的 three 处"假数据"：离线 Mock 雷达六维失真（creativity 恒 0、其余恒 5、永不 FIRED）、裁判 verdict 的 user_fit / evidence_trace 被丢弃（Leaderboard"契合"列用 task*20 冒充）、roi_norm 恒 0（population 从未传入，"ROI z"列永远 0.00）。修复后断网演示时雷达可复现且 agent 间有区分度、FIRED 可达；契合度与证据留痕真实落地；ROI z 成为真实 z-score。

## Background

- **问题 1（`src/services/judgeClient.ts`）**：`fallbackMock` 经 `usageToTelemetry()` 把 usage 伪造成全成功遥测（success:true / first_try:true / rework:0）→ `computeKpi` 产出 TCR/FSR/AR 恒 1、`cross_task_generalization` 恒 0 → 雷达 creativity 恒 0、其余四维恒 5、verdict 永远 MVP/OBSERVE。
- **问题 2（`src/stores/evaluation.ts` / `src/types/evaluation.ts`）**：`runEvaluation` 只取 `verdict.verdict` 映射生命周期，`user_fit` / `evidence_trace` 不落地（`EvaluationProfile` 无字段承载）；`computeLeaderboard` 的"契合"列用 `radarLatest.task * 20` 冒充。
- **问题 3（同文件）**：`buildRoiSnapshot` 的 `population` 参数从未传入，`RoiSnapshot.roi_norm` 恒 undefined/0，Leaderboard "ROI z" 列永远 0.00，排序按裸 roi。

## Requirements

### 问题 1：fallbackMock 雷达派生重写（`src/services/judgeClient.ts`）

- 参考 `model-service/app/evaluator.py` 的 `_derive_run_radar`：
  - 成本维：由真实 usage 成本折算（保留现有公式 `clamp(5 - totalCost/1.0*5, 0, 5)`）。
  - 其余五维：由 agentId 确定性哈希派生（base + jitter，对齐 Python 侧 base 值 task/quality/reliability=3.0、comm/creativity=2.5，jitter 0–2），保证可复现、agent 间有区分度、FIRED 可达。
- 有真实遥测时仍走 KPI 路径：`JudgeRunInput` 增加可选 `telemetry?: TelemetryEvent[]`（仅加法，后端 pydantic 默认忽略未知字段，与 `convergence` 字段同先例）；`runEvaluation` 把 `collectRunData` 的真实 `events` 传入；`fallbackMock` 仅在 `telemetry` 缺失/为空时使用哈希派生。
- 移除 `usageToTelemetry()` 伪造逻辑；哈希路径的 evidence_trace 诚实标注来源（对齐 Python：`total_cost` / `avg_radar` / `source=mock`）。
- 测试（`tests/unit/judgeClient.test.ts`）：保留"确定性：同输入→同分数"与 cost 维断言语义；补充"不同 agentId 雷达不同""FIRED 可达"用例；补充真实遥测走 KPI 路径用例。

### 问题 2：verdict user_fit / evidence_trace 落地

- `EvaluationProfile`（`src/types/evaluation.ts`）增加可选字段 `userFitLatest?: number`、`evidenceTraceLatest?: string[]`（向后兼容存量落库数据）。
- `runEvaluation`（`src/stores/evaluation.ts`）捕获 verdict 事件的 `user_fit` / `evidence_trace` 并写入画像；无 verdict 时沿用既有值。
- `computeLeaderboard` 的 `user_fit` 改用 `userFitLatest`，缺省回退 `task * 20` 并注释说明。
- 核对 `src/pages/Evaluation/Leaderboard.tsx` 契合列字段来源（渲染 `LeaderboardEntry.user_fit`，修复后来源即正确，无需改 UI）。

### 问题 3：roi_norm 接通真实 population

- `runEvaluation` 第 4 步：把其余 profile 的 roi 值作为 `population` 传入 `buildRoiSnapshot`，使落库快照的 `roi_norm` 为真实 z-score（RoiPanel 同步受益）。
- `computeLeaderboard`（`runLeaderboard` 重算统一接入点）：用当前全部 profile 的 roi 数组经 `roiEngine.zscore` 重算每条目的 `roi_norm`（与 `computeRoi` 内 `roi_norm = zscore(population, roi)` 同一计算；无法重调 `buildRoiSnapshot` 因 entries/telemetry 不留存）。群体 ≥2 时排序按 roi_norm 优先；单 agent 时 z-score 无区分度，回退裸 roi 排序，注释说明。

## Constraints

- 最小改动，不动无关代码；类型变更仅加可选字段，向后兼容。
- `corepack pnpm typecheck`、`corepack pnpm lint:check`（0 error）、`corepack pnpm test` 全绿。
- 不 git commit / push（archive 脚本自身 auto-commit 可接受）。

## Acceptance Criteria

- [ ] 离线 fallbackMock：同 agentId 同输入 → 同雷达（确定性）；不同 agentId → 雷达不同；存在 agentId 使 verdict = FIRED（cost 拉低时）；creativity 不再恒 0。
- [ ] 传入真实 telemetry 时 fallbackMock 走 KPI 路径（radar 由 computeKpi 派生）。
- [ ] verdict 的 user_fit / evidence_trace 落入 EvaluationProfile 并随 loadAll 恢复；Leaderboard 契合列优先取 userFitLatest。
- [ ] 多 agent 时 Leaderboard ROI z 列为真实 z-score（非恒 0.00），排序 roi_norm 优先；单 agent 回退裸 roi。
- [ ] 三条验证命令全绿。
