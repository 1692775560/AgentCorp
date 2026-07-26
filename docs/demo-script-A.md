# AgentCorp · 阶段 A 演示脚本（绩效中心 · 60s Mock 走通）

> 配套：implementation-playbook.md §2.11 / 评估子系统设计 v0.1-eval §5
> 模式：`VITE_MOCK=true`（默认，无需 NPU / 朋友模型层）

## 0. 运行方式

```bash
npm install        # 首次
npm run dev        # 启动 Vite（默认端口 5173）
# 浏览器打开 http://localhost:5173
```

启动后默认仍在「入职评估」Tab（原有 hero demo 四模态闭环不受影响）。
点击顶部「**绩效中心**」Tab 进入阶段 A 看板。

## 1. 60 秒演示走查（确定性合成数据）

| 时间 | 操作 / 画面 | 说明 |
|---|---|---|
| 0–5s | 顶部切「绩效中心」；左侧候选列表按 user_fit 降序（琳达 / 老张 / 阿强） | 数据由 `telemetrySynth` 用固定 seed 合成，每次一致 |
| 5–15s | 点选「老张 · 后端稳健 Agent」→ RoiDashboard 大数字点亮（ROI / 成本 CU / 价值 CU） | ROI 趋势 sparkline 显示近 12 窗口走势 |
| 15–25s | KpiTable 八格填充：TCR / FSR / RR / ADL / AR / ER / CGR / SCR；越阈值标红 | 客观 KPI 来自合成 TelemetryEvent 聚合 |
| 25–35s | LifecyclePanel：当前态「在岗」，时间线显示「试用期评估通过，正式入职」 | 入职→在岗迁移事件 |
| 35–45s | Leaderboard：榜首「琳达」金边 MVP / 「老张」正常 / 「阿强」红标「末位·待观察」 | 排名按 ROI 群体 z-score |
| 45–55s | 点「月度擂台」→ 阿强（末位）触发 `monthly_arena` → 状态转为「培训(PIP)」；LifecyclePanel 新增一条迁移事件 | strategyEngine 状态机驱动 |
| 55–60s | （可选）点阿强行内「执行淘汰」或 LifecyclePanel「一键 fire」→ 状态转「已淘汰」，Leaderboard 末位标红 | manual → RETIRED |

## 2. 数据来源说明（防「太假」）

- 遥测质量随候选六维能力变化：能力越低 → 失败/返工/升级概率越高、时延越长（见 `telemetrySynth.synthTelemetry`）。
- ROI 由成本五要素 + 价值两要素按 `roiEngine.computeRoi` 折算；`cost_perf` 融合客观 CPS 与主观雷达 `cost` 维（λ=0.5），并回灌 `user_fit`（呼应 PRD R3/R5 防注水）。
- 群体 z-score 让不同 agent 横向可比（末位淘汰有统计意义）。

## 3. 退出标准 `IS_PASS_A`

- [x] `npm run build` 通过
- [x] `npm run typecheck`（tsc --noEmit）零错误
- [x] 上述 60s 脚本在 Mock 模式下逐帧跑通
- [x] 三引擎（`metricsEngine` / `roiEngine` / `strategyEngine`）为纯函数，可单测
- [x] 原入职评估 hero demo 默认不受影响

## 4. 已知边界（阶段 A）

- 真实模型推理（`VITE_BACKEND=real`）与真实遥测回填属阶段 B / C，本轮仅留 `evaluationAdapter` / `roiEngine` 接口，未接真实 SSE。
- 语音宣判仍走 Mock 路径（`speechSynthesis`），真实 TTS 接入见阶段 B。

## 5. 验证数据快照（确定性合成，可复现）

由 `scripts/check-engines.ts` 跑出（固定 seed，两次运行完全一致）：

**擂台排名**

| 名次 | 候选 | tier | 状态 | user_fit | roi | roi_norm(z) | cost fusion score |
|---|---|---|---|---|---|---|---|
| #1 | 琳达 · 全模态 UI Agent | MVP | ACTIVE | 86.5 | 0.37 | 0.73 | 2.68 |
| #2 | 老张 · 后端稳健 Agent | NORMAL | ACTIVE | 60.0 | 0.35 | 0.69 | 2.42 |
| #3 | 阿强 · 全栈自夸 Agent | BOTTOM | ACTIVE | 44.5 | -0.57 | -1.41 | 0.71 |

**候选-02（老张）KPI**（八维客观质量）

```
TCR=95% FSR=75% RR=5% ADL=2256ms AR=100% ER=0% CGR=89% SCR=100%
```

> 说明：`cost fusion score` = `cost_perf_score`，为客观 CPS 与主观雷达 cost 维融合（λ=0.5）后的 0–5 分；负 roi 正确触发末位 BOTTOM 标红。

