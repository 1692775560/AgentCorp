# AgentCorp 深度代码审阅报告

> 审阅日期：2026-08-18 · 审阅范围：全仓（约 14 万行 TS/TSX/PY，1817 个文件）
> 审阅方式：逐文件精读核心链路 + 全量实跑（typecheck / vitest / pytest / lint / 自带 QA 脚本）
> 定位：为 GOAI 大赛、昇腾大赛及 Agent 赛道提交做「技术可信度」与「产品成熟度」双重体检

---

## 0. 一句话结论

**工程质量在学生/初创作品里属于上游（注释密度、降级设计、契约对齐、测试覆盖都超出预期），
但"产品叙事"跑在"代码事实"前面约半个身位。** 现在最大的风险不是代码写得不好，
而是 README 承诺的若干能力在代码里查无实据，或实现路径与宣称口径不一致 ——
这恰恰是懂技术的评委最容易一 grep 就抓住的地方。

评级（10 分制）：

| 维度 | 分 | 说明 |
|---|---|---|
| 工程规范 | 8.5 | 双 tsconfig 严格类型、957 前端用例 + 282 后端用例全绿、CI 齐备、隐私 grep 门禁 |
| 架构设计 | 8.0 | 契约前后端镜像、JudgeBackend 协议抽象、降级三态、纯函数引擎层可单测 |
| 评测方法论 | 6.0 | 框架成熟（rubric/锚点/ensemble/pass^k/α），但关键环节存在自我抵消（见 §4） |
| 叙事一致性 | 4.5 | README 声明的 GitHub 导入、VITE_MOCK 开关、部分测试项在代码中不存在（见 §3.1） |
| 产品收敛度 | 5.0 | 18 条路由、三套并行子系统（评测 / 像素办公室 / 多 Agent 编排），主线被稀释 |
| 可运维性 | 4.0 | 评测结果无持久化数据库、榜单进程内内存态、无多用户/无导出 |

---

## 1. 实测结果（可复现）

```
corepack pnpm install --ignore-scripts   → 成功（38s）
corepack pnpm typecheck                  → PASS（tsc 双配置，零错误）
corepack pnpm test                       → 957 passed / 87 suites，仅 collectors.test.ts
                                           因沙盒未装 Electron 二进制而失败（非代码问题）
corepack pnpm lint:check                 → 0 error / 50 warning（均为 no-explicit-any 与测试文件未用变量）
node scripts/i18n/check-parity.mjs       → zh/en 9 个 namespace parity OK
bash scripts/privacy-grep.sh             → CLEAN
node scripts/qa/release-verify.mjs       → 总结论 PASS
model-service: MOCK=true pytest -q       → 282 passed / 18 skipped
corepack pnpm knip                       → ✗ 崩溃（oxc-parser Array buffer allocation failed），死代码门禁实际未生效
```

**结论：CI 声称的门禁都真实存在且真的绿。** 这一点在比赛作品里很少见，应当在答辩里明确亮出来。
唯一失效的是 `knip`（死代码检测）——它一崩，仓库里就积下了没人发现的孤儿模块（§3.2）。

---

## 2. 架构精读（按数据流）

### 2.1 评测链路（这是项目的心脏）

```
渲染层 judgeClient/craftClient
   → hostApiFetch → IPC → 主进程 127.0.0.1:3210（token 鉴权）
   → model-service FastAPI
   → judge_backend（http / local / mock 三实现）
   → SSE：radar_update×6 → narration → audio → verdict → done
```

**做得好的地方（可以放心当卖点讲）：**

- `model-service/app/judge_backend.py`：把推理后端抽象成 `JudgeBackend` Protocol，HTTP 实现只用标准库
  `urllib`（零新增依赖），统一采集 `ttft_ms / latency_ms / usage`。`MockJudgeBackend.available` 恒为
  `False` 且 `complete()` 必抛 —— **明确拒绝伪造分数**，强制调用方走降级分支。这是全仓最漂亮的一个设计决策。
- `evaluator.parse_output()`：对量化小模型的输出做了三层救援（```json 代码块剥离 → 首尾花括号截取 →
  `_safe_float` 容忍 "4分"/"4/5"/嵌套 dict），还有"量纲救援"（六维全落在 (0,1] 时判定模型误用 0-1 量表，
  统一 ×5）。这是真跑过小模型的人才会写的代码。
- `_derive_run_radar()` 的注释明确写了「**不再用 agent_id 哈希造分**」，并解释了为什么哈希派生等于把随机数
  当结论。这种自我否定式的注释是可信度资产。
- `craft_judge.py` 的 SYSTEM_PROMPT 六条铁律（必须给 quote、找不到原文 hit 必须 false、不得自行扩维、
  空口承诺必须标 padding、0.5 步进锚点、参考答案作为 5.0 锚定）+ `parse_craft_output` 丢弃越界维度、
  缺失维记入 `unscored_dims` 不补默认分 —— 评分纪律严于大多数开源 LLM-as-judge 实现。
- `craft_tasks.py` 的 12 道题**内容本身质量很高**：`code_debug_race` 要求给两种修法及各自代价、
  `text_rewrite_audience` 埋了 80 字硬约束当指令遵循探针、`image_conflict_rule` 考察冲突需求的处理。
  每题都带 `probes`（反注水探针），这是原创性最强的一块资产。
- 安全：Host API 每会话随机 32 字节 token（`electron/api/server.ts`），CORS 白名单只放行 `app://.` 与
  `null`（`electron/api/route-utils.ts:19`），PostHog key 强制来自环境变量、无 key 直接不初始化
  （`electron/utils/telemetry.ts:18`），`/api/craft-tasks` 公开题库**不返回参考答案**（防刷题）。

### 2.2 前端引擎层

`src/engine/` 全是纯函数、无副作用、可单测，这个纪律守得很好：
`passK` / `ranking`（Krippendorff α 多评委版）/ `metaJudge` / `irt`（面试自适应出题的信息增益）/
`paretoRank`（质量×成本前沿）/ `convergence/pca`（纯 Python 幂迭代的 2D 投影，不引 numpy）。
`judgeEnsemble.ts` 里那段关于矩阵朝向的注释（行=维度、列=第 k 次运行，转置错会让稳定 agent 算出负 α）
说明作者真的踩过并修过这个坑。

### 2.3 桌面壳与多 Agent 编排

`electron/`（约 3.5 万行）与 `src/engine/squad/`（约 1600 行）基本继承自 ClawCorp/OpenClaw，
但 `squadOrchestration.ts` 是**实打实的原创增量**：DECOMPOSE → ASSIGN → KICKOFF → EXECUTE∥REVIEW →
CROSS_REVIEW → REPLAN → SUMMARIZE，并显式对治了 MAST(arXiv:2503.13657) 的 verification gap
（结构化验收 checklist + 第三方盲审）、引入 MetaGPT 式 requiredSections 机检、MoA 双草案合成、
以及 callBudget 预算护栏（防 termination failure）。这一块的设计水平高于评测层。

---

## 3. 缺陷清单

### 3.1 P0 —— 叙事与代码不符（评委一 grep 就破防，必须本周修）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P0-1 | **README 宣称"支持导入开源 Agent（GitHub 一键导入）"，代码中不存在该功能** | `src/types/marketplace.ts:33` 定义了 `'github_import'`、:47-59 定义了 `GithubImportMeta`，但全仓 `grep github_import` **零处使用**；全仓无任何 `api.github.com` / `raw.githubusercontent` 调用 | 核心能力表第一行落空 |
| P0-2 | README 测试覆盖列表声称含「GitHub 导入输入侧安全加固」测试 | `grep -ri github tests/ model-service/tests/` **零命中** | 等于虚报测试 |
| P0-3 | README §4 结尾「前端切真实模式：`.env` 里设 `VITE_MOCK=false`、`VITE_API_BASE=...`」 | 全仓 `grep VITE_MOCK\|VITE_API_BASE` **零命中**，`.env.example` 里也没有 | 评委照做会失败 |
| P0-4 | `.env.example` 完全没有 `JUDGE_BACKEND / JUDGE_BASE_URL / JUDGE_API_KEY / JUDGE_MODEL` | `.env.example` 全文 | 快速开始的第一道坎 |
| P0-5 | **"做图"工种从未涉及真实图像** | `craft_tasks.py:274-360` 四道 image 题全是让 agent 用**文字**描述构图/色值/提示词 | 与"全模态评测"的叙事冲突 |
| P0-6 | 榜单永远显示 agentId 而非人名 | `src/stores/evaluation.ts:276` `computeLeaderboard(profiles, {})` —— names 映射恒为空对象，`:174` 回退 `?? item.profile.agentId` | 演示核心页面的可见 bug |

### 3.2 P0 —— 方法论自我抵消（见 §4 详述）

| # | 问题 | 证据 |
|---|---|---|
| P0-7 | Q6「缺真实执行证据则降权」被 LLM 引文绕过 | `stage_scorer.py:79` 只判断 `dim not in craft_evidence`；而 `src/engine/interview/craftAggregate.ts:85 buildCraftEvidence()` 用**裁判自己输出的 quote** 填充 craftEvidence，于是 `code_runnability` / `code_security` 的 ×0.4 降权几乎永远不会触发 |
| P0-8 | ensemble 重复 k 次，但 temperature 恒为 0 | `model-service/app/config.py` `TEMPERATURE` 默认 `0.0`，`judge_backend.py:113` 直接透传 → 同输入必得同输出。k=3 的"重复测量抑制噪声"实际只靠 `rubricVariant` 旋转维度顺序制造扰动 |
| P0-9 | 前端离线回退仍用 agentId 哈希造分 | `src/services/judgeClient.ts:265 hashAgentId()` / `:440-450`。后端已明确废弃该做法并写进注释，前端未同步 —— 离线演示时不同 agent 的差异**完全来自名字的哈希值** |
| P0-10 | 降级分照常进榜 | `src/stores/evaluation.ts:279-460` 把 `judgeSource='degraded'` 的 profile 正常 `evalSave` 并 `runLeaderboard()`；排序键只有 ROI z-score，不区分来源 |

### 3.3 P1 —— 工程性问题

| # | 问题 | 证据 |
|---|---|---|
| P1-1 | **孤儿模块**：`src/engine/evaluation/metaJudge.ts`（280 行，README 重点宣传的"评委元评估"）与 `src/engine/interview/itemBank.ts`（265 行）**只被自己的测试引用**，主应用零调用 | 直接 grep import 路径可验证 |
| P1-2 | 死代码门禁失效 | `pnpm knip` 崩溃（oxc-parser OOM），所以 P1-1 一直没被发现 |
| P1-3 | 评测结果无持久化 | `model-service/app/routes/leaderboard.py:45` `_STAGE_STORE` 是进程内 dict；重启即清零。榜单在无数据时回落 `_mock_leaderboard_entries()`（写死 agent-a/b/c，:49） |
| P1-4 | rubric 作为"数据"注入 transcript | `src/services/judgeClient.ts:674-700` 把 persona/history/rubric 前缀拼进 `transcript` 字段；后端 `evaluator._build_run_prompt()` 又对 transcript 做 `[:4000]` 截断 —— 前缀既占用证据预算，又存在被候选输出内容覆盖/注入的风险 |
| P1-5 | 收敛层的"语义"是词袋哈希 | `model-service/app/scoring/encoder.py`：md5(token) % 64 累加后 L2 归一。docstring 声称"同义改写得到近似向量"，但同义改写换词后 token 集合不同，落点也不同 —— 该假设不成立 |
| P1-6 | 双 Web 配置重复 | 根目录同时存在 `vite.config.web.ts`（port 3000）与 `vite.web.config.ts`（port 5174），命名近似、职责重叠，仅后者被 `pnpm web` 使用 |
| P1-7 | 新页面无 i18n | `src/i18n/locales/{zh,en}` 的 9 个 namespace 全部继承自 ClawCorp（agents/chat/settings/setup/skills/channels…）；Interview / Arena / Office 页面 `useTranslation` 零使用，文案硬编码中文 |
| P1-8 | 候选池语义偏差 | `resources/marketplace/` 下 285 个模板是 **prompt persona**（SOUL.md/AGENTS.md/IDENTITY.md），跑在同一个底层 LLM 上。因此当前评测比较的是"人设+提示词"，不是产品意义上的"不同 Agent"（Coze/Dify/Claude Code/Cursor…） |
| P1-9 | src/demo/ 是第二个独立应用 | `demo.html` + `src/demo/main.tsx`，含 governance/observability/plugins/skills 共约 3200 行，**主应用零 import**。它是给评委看"多 Agent 闭环"的展板，与产品主线割裂 |

### 3.4 P2 —— 小问题

- `electron/api/route-utils.ts:49` 会话 token 用 `===` 比较，非常量时间（本地回环风险极低，但审计会提）。
- `model-service/app/config.py` `DEVICE` 默认 `"npu"` —— 绝大多数机器上是个必然失败的默认值，建议 `auto`。
- `JUDGE_BACKEND` 默认 `mock` + `MOCK` 默认 `false` 的组合，会让首次启动者进入"看似真实、实为 fixture"的
  `auto` 分支（`evaluator.evaluate()` 尾部）。默认态应当更喧哗地告知用户。
- 50 条 eslint warning 集中在 `any`，建议在评审前清零，成本很低但观感差别大。
- `.github/workflows/ci.yml` 只在 `main` / `feat/*` push 触发；当前工作分支不在其列（PR 仍会触发）。

---

## 4. 方法论审查（评委最会打的地方）

README 用整整一节论证"评估结论为什么可信"，四条论据分别对应：重复测量、稳定性检查、抗偏差设计、来源标注。
逐条核对代码后的实际状况：

| README 论据 | 代码实现 | 实际强度 |
|---|---|---|
| 「同一份作答独立评多次，每次都达标才判定为通过」 | `passK.ts` + `judgeEnsemble.judgeChatEnsemble(k=3)` 确实存在且被 `stores/evaluation`、`stores/interview` 调用 | **中**：k 次调用是真的，但 temperature=0 使 k 次近乎同一结果，pass^k 退化为 pass^1 的复读 |
| 「多次评分离散过大时下调置信度并转人工复核」 | `auditJudgeBias()`（maxSpread>1.5 → 置信 ×0.8）+ Krippendorff α<0.67 → ×0.9，证据链里写明"建议人工复核" | **中高**：逻辑正确，但因上一条，离散度天然接近 0，警报几乎不会响 |
| 「轮换维度顺序、固定评分锚点、明确要求不因回答长而给高分」 | `JUDGE_RUBRIC_ANCHORS` + `rotateDims()` + 反冗长条款，全部真实存在 | **高**：这是全项目最扎实的抗偏差实现 |
| 「分数分为真实裁判 / 部分降级 / 完全降级三态，降级结论不进入经验库」 | `EnsembleSource: 'judge' \| 'mixed' \| 'degraded'` 三态真实；`src/demo/agentteams-adapter.ts:470` 确实做了"degraded 不沉淀经验规则" | **中**：但那是 demo 子应用；主应用的榜单（`stores/evaluation.ts`）不做任何来源过滤 |

**另外两个尚未在文档中承认的方法论边界（建议主动写进"已知边界"，主动坦白比被问出来强十倍）：**

1. **"代码工种"的评分没有执行验证。** `code_runnability` 的分数来自模型阅读答案后的判断，而不是把代码
   跑起来。项目自己意识到了（`CRAFT_REQUIRES_REAL`），但降权闸门被 P0-7 抵消了。
2. **裁判与候选可能同源。** `JUDGE_MODEL` 与候选 agent 走的 gateway 模型没有互斥校验；若两边都指向
   qwen-plus，自我增强偏差直接坐实，而 README 恰恰把"不绑定单一大厂"当作抗偏差的架构保障。
   建议加一个 `judge_model == candidate_model` 的显式告警。

---

## 5. 产品化建议

### 5.1 定位：把"评测框架"收敛成"选人决策"

目前仓库同时装着三个产品：
**(A) Agent 准入评测台**（marketplace → interview → evaluation，原创、差异化最强）、
**(B) 数字员工工位/像素办公室**（office 9400 行 + team-map + kanban，视觉吸睛但与主张无关）、
**(C) 多 Agent 协同编排器**（squad 1600 行，技术水平最高但属于"干活"不属于"选人"）。

对普通职场人的真实心智是：「**我这份活，到底该用谁？**」——建议主线只留 A，把 B 降级为可选的
"结果可视化皮肤"，把 C 定位成 A 的**证据来源**（让候选真在一个真实任务里干活，产出用于评测的 transcript），
而不是并列的第三个功能区。

### 5.2 MVP 边界（建议对外这样定义）

> AgentCorp 是一个**本地运行的 Agent 准入评审台**：
> 你描述一次真实工作 → 系统让候选 Agent 做同一套工种实测题 →
> 由可替换的裁判模型按同一份 rubric 逐条给证据打分 →
> 输出一张带证据链、标注来源与置信度的准入报告，并由你在主观榜上做最终排序。

这一句里每个动词现在都有代码支撑，**不要再多承诺一个字**。

### 5.3 差异化护城河（按可信度排序，答辩时按这个顺序讲）

1. **题库 + rubric + 反注水探针**（12 道题、可核验 checkpoints、埋点式 probes）——这是别人抄不走的手工资产。
2. **证据链而非分数**（每条 checkpoint 必须带原文 quote，无引文即无效判定）——从"打分"升级为"举证"。
3. **来源三态透明披露**（judge / mixed / degraded）——业内几乎没人这么做，是诚实性的具象化。
4. **裁判后端可替换 + 元评估**（JudgeBackend 协议 + metaJudge + α 一致性）——接完线就是完整故事。
5. 双榜（客观 + 主观重排）——理念好，但目前实现较轻，别放在第一位讲。

### 5.4 两周冲刺清单（按 ROI 排序）

**第 1 周 · 止血（让说的和写的一致）**

1. 修 P0-1~P0-6：要么 3 天补出真实的 GitHub 导入（`GET /repos/{owner}/{repo}` + 派生 profile，
   带 URL 白名单与超时），要么把 README 那一行改成"上传自有 Agent / 从本地模板导入"。**二选一，别拖。**
2. 修 P0-7：把 `craftEvidence` 拆成 `judgeEvidence`（模型引文）与 `verifiedEvidence`（真实执行/扫描结果），
   `stage_scorer` 的降权只认后者。改动约 30 行，但把项目最重要的诚实性护栏救回来了。
3. 修 P0-9：把 `fallbackMock` 的哈希派生删掉，无遥测时六维返回 `null` 并在 UI 显示"未评测"。
   宁可留白，不要造分 —— 这与项目自己的价值观一致。
4. 修 P0-6（榜单人名）与 P0-10（榜单按来源分区展示）。
5. `.env.example` 补齐 JUDGE_* 与 CANDIDATE_* 全量变量 + 三行注释。

**第 2 周 · 拉开差距（做出别人没有的东西）**

6. **给 code 工种接一个真沙盒**：`code_csv_merge` 这类题本来就带测试用例，用 Docker/子进程跑
   pytest，把通过率作为 `code_runnability` 的**真实**证据。一旦有这个，"我们的分数可执行验证"
   就是全场唯一。这是投入产出比最高的一件事。
7. **把 metaJudge 接进 UI**：评估页加一块"裁判健康度"卡片（accuracy / 漂移方向 / 最弱维度 /
   置信校准 gap）。代码已经写完了，只差 200 行的接线和一个面板 —— 白捡的差异化。
8. **ensemble 真实化**：`TEMPERATURE` 在 ensemble 路径下改为 0.3~0.7，或改为跨模型（k 次轮转不同
   JUDGE_MODEL）。同时在报告里输出 k 次的分数分布图。
9. **持久化**：`_STAGE_STORE` 换成 SQLite（`sqlite3` 标准库，零新增依赖），并支持
   "导出评审报告 PDF/Markdown" —— 职场人真正会用的是那份能贴进周报的报告。
10. 删掉或明确标注 `src/demo/`：改名为 `examples/closed-loop-demo/` 并在 README 单列一节，
    别让它看起来像主应用的一部分。

### 5.5 演示脚本（8 分钟版，建议按此彩排）

1. **0:00-0:45 痛点**：打开 marketplace，展示 285 个候选，问"你怎么选？看 star 吗？"
2. **0:45-2:00 输入真实工作**：粘一条真实需求（如"合并两份订单 CSV 并处理脏数据"），
   系统自动推断工种为 code 并给出匹配排序（`taskMatch` + `matchScore` 是真实计算，可以放大讲）。
3. **2:00-4:30 同题实测**：选 3 个候选，一键"跑同一道题"→ 实时展示各自的答案 →
   逐条 checkpoint 的 hit/miss + 原文引用 → **重点停在"未命中"和"padding 探针命中"上**（反注水最抓人）。
4. **4:30-6:00 证据链与来源三态**：展开 evidence_trace，指出哪些维度是 judge、哪些是 degraded、
   哪些标了"缺真实执行·降权"。这一段是全场唯一敢自曝其短的演示。
5. **6:00-7:00 双榜**：客观榜 vs 拖动权重后的主观榜，展示排名分歧（`RankDivergence` 已实现）。
6. **7:00-8:00 可替换裁判**：现场把 `JUDGE_MODEL` 从 A 换成 B，重跑一题，展示分数与 α 的变化，
   收尾在"我们不主张分数正确，我们主张过程可复核"。

### 5.6 三个赛道的包装差异

- **阿里 GOAI**：主打"任何 OpenAI 兼容端点即可当裁判"，现场用百炼/通义跑通；强调
  `judge_backend.py` 零依赖标准库实现、ttft/latency/usage 全采集，成本可归因。
- **华为昇腾**：主打 `model_loader.py` + `LocalJudgeBackend` 的惰性 import 与优雅降级
  （`DEVICE=npu`、`torch_npu` 缺失自动降级不崩），并补一段"在昇腾环境实测的 TTFT/吞吐对比表"。
  **注意：`DEVICE` 默认值现在就是 `npu`，这是个可以顺势讲的巧合，但要先把 `auto` 逻辑补好。**
- **通用 Agent 赛道**：主打 `squadOrchestration.ts` 的论文对治设计（MAST verification gap /
  MetaGPT 结构化契约 / MoA 双草案 / 预算护栏）+ Skill 契约的失败降级语义。

### 5.7 商业化路径（如果被问到）

- 免费本地版（现状）→ 团队版（共享题库 + 评审报告归档 + 准入审批流，
  `electron/api/routes/approvals.ts` 已有雏形）→ 企业版（自建题库、私有裁判、审计留痕合规）。
- 真正的资产不是软件，是**题库 + rubric + 各行业的准入基线数据**。越早开始沉淀跨用户的
  匿名评测数据（`reactions-remote.ts` 已预留接口层），护城河越深。

---

## 6. 给答辩的三句"预防针"

评委大概率会问的三个问题，建议主动在演讲里先答：

1. **「你们用模型评模型，怎么保证裁判可信？」**
   → 答：我们不保证正确，我们保证**可复核**。三态来源标注 + 每条判定必须带原文引用 +
   k 次一致性审计 + 裁判后端可换。并主动说出边界："当前只主张结论稳定，未验证预测有效性。"
2. **「跟 HELM / Chatbot Arena 有什么区别？」**
   → 答：它们测通用能力，我们测**这一份工作**。同一套工种题 + 使用者自定义权重的主观榜，
   评的是"契合度"不是"能力值"。
3. **「一个人只用一个 Agent，你这套评估是不是过度设计？」**
   → 答：是。README §6 已经写明"单次任务 + 单一已知 Agent 场景下本层是额外开销"。
   这份坦白本身就是加分项，一定要主动讲。

---

## 附：本次审阅重点阅读的文件

`model-service/app/`：`evaluator.py`(960) · `judge_backend.py` · `candidate_runner.py` ·
`config.py` · `scoring/{craft_tasks,craft_judge,stage_scorer,rules_engine,registry,encoder}.py` ·
`routes/{judge,leaderboard,evaluate,convergence}.py`

`src/`：`services/{judgeClient,judgeEnsemble,craftClient,interviewRunner,speech}.ts` ·
`engine/{evaluation/metaJudge,evaluation/passK,interview/craftAggregate,squad/squadOrchestration,
scoring/registry}.ts` · `stores/{evaluation,interview,marketplace}.ts` · `App.tsx` ·
`pages/{Evaluation,Marketplace,Setup}/`

`electron/`：`api/{server,route-utils,reactions-remote}.ts` · `utils/telemetry.ts` ·
`main/ipc-handlers.ts`（抽查 marketplace 段）
