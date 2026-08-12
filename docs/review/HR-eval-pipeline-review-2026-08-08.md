# AgentCorp HR 评测管线改造检验报告

> 日期：2026-08-08 · 对象：LLM-as-judge 改造（MiniCPM-o 推理路径 / 工种评测集 / rubric 逐维打分）
> 范围：`model-service/app/`（evaluator / judge_backend / model_loader / config / scoring/*）+ 前端 `src/engine/*`

## 一、总评

改造方向完全正确，核心设计符合成熟评测体系（HELM / Chatbot Arena / SWE-bench）的通用原则：**同题同 rubric、固定裁判、逐条要点判定、未覆盖维度不补分**。md5 造分已彻底移除，降级路径诚实标注（`source=degraded`），前端三源解析层公平性约束到位。**存在 1 个阻断性硬伤（serve.py 门禁），本次已修复；另有 1 个"实现未接线"的缺口，需补 API 端点。**

## 二、已验证修复点（✓）

| 项 | 结论 | 位置 |
|---|---|---|
| `infer()` 不再是空实现 | ✓ 经 `judge_backend.get_backend().complete()` 走 http/local/mock 三后端 | evaluator.py:315 |
| `_derive_run_radar` 不再用 md5(agent_id) | ✓ 改为 transcript 弱信号（体量/结构/具体性）+ 真实 usage 折算 cost；零证据 → 全维中性 2.5 | evaluator.py:551 |
| 降级与真实分数可区分 | ✓ mock-run 流 confidence=0.35 且 evidence 标注 source=degraded | evaluator.py:643-673 |
| `settings.device` 被真实读取 | ✓ `LocalJudgeBackend(model_path, settings.device)`，`.to(self.device)` | judge_backend.py:274,191 |
| 工种评测集 | ✓ code/text/image 三类共 9 题，每题含 prompt + checkpoints + 反注水 probes，维度键复用 JOB_CRAFT_DIMS | craft_tasks.py |
| rubric 逐维打分解析 | ✓ 越界维丢弃、无 quote 的 hit 降级为 miss、缺失维进 unscored 不补默认分、0.5 步进夹取 | craft_judge.py:135 |
| 反注水 | ✓ probes 显式给裁判 + padding 判定字段 | craft_judge.py:173, craft_tasks.py |
| 前端启发式公平性 | ✓ heuristicRadar 移除 rating/hiredCount 进能力维；quality/reliability 只用自述信号且压到 ≤3.5；`allowHeuristic` 默认 false → 无数据时卡片引导「S1 初审」 | radarSource.ts:181,239 |
| GitHub 导入加固（附带） | ✓ 新增 name/路径/URL 白名单校验、超时与体积上限、hasTests/hasCi 替代 fork 数 | githubImport.ts |
| 单测 | ✓ 新增 test_craft_judge.py（题库自洽/解析/聚合）；test_evaluate_run.py 已更新 | tests/ |

## 三、硬缺口（✗）

### 1.【已修复】serve.py 真实评测门禁挂在死代码上 —— 真实通道完全不可达
- 现象：`/api/evaluate` 与 `/api/evaluate-run` 均先检查 `get_model().available`（model_loader），而 `load_minicpmo` 的真实加载仍整段注释、`available` 恒为 False → **只要 MOCK=false 就 503，新接的 judge_backend 永远走不到**。
- 修复（本次已改 `model-service/app/serve.py`）：两处门禁改用 `judge_available()`（后端可用即放行），错误信息给出配置指引；`/health` 新增 `judge_available` / `judge_backend` 字段便于诊断。`py_compile` 通过。

### 2.【待办】craft 试做题评测「库已就绪，端点未接线」
- `judge_craft_task(task_id, answer)` 目前**没有任何调用方**（无 API 路由、无 S2 面试流程引用）。
- 需补：① `/api/craft-judge` 端点（入参 task_id + answer）；② "跑题"环节——把 `CraftTask.prompt` 发给候选 Agent、捕获其答案再送评（当前 craft_judge 只吃现成 answer 字符串）；③ 结果并入 S2 面试/绩效流（dims 合入六维或独立 craft 维展示）。

## 四、遗留与改进建议（⚠）

1. **面试对话证据仍是正则（dimTracker.ts:111 `evidenceStrength`）**：live 面试的逐轮证据强度仍靠「有数字/有换行/出现如果」计数 + HR 手动分。这不是错误（已诚实降级），但意味着"HR 真实推理面试"目前只有**试做题**部分是真 LLM-as-judge，对话部分仍启发式。下一步应把对话轮次送 judge 后端做逐轮评分。
2. **model_loader 已成遗留死代码**：真实推理已全部收敛到 judge_backend，`load_minicpmo` 的注释块与 `to_npu` 透传建议删除或与 LocalJudgeBackend 合并，避免再误导后人（它就是这次 serve.py 门禁事故的根源）。
3. **http 后端 `available` 不探测连通性**：URL 配错时 auto 模式会在第一次请求才抛 JudgeUnavailable 并冒到客户端。建议在 serve.py 包一层 catch（JudgeUnavailable → 返回 `source=degraded` 的 mock-run 事件而非 503），或 http 后端加轻量 `/models` 探测。
4. **task_sets.py:81 `input.task and "code" or "code"`** 恒等于 `"code"`，属残留笔误（UsageEfficiency 不评 craft 维所以无害），建议改为显式 `"code"` 并注明。
5. **多模态仍是占位**：`load_media` 只返回计数不真正解码（真实通道=文本，与 craft_tasks 文本通道设计一致，但应在文档写明"多模态评测 = 下一里程碑"，避免大赛评审误读为已实现）。
6. **craft 评分温度**：`build_craft_messages` 走 `settings.temperature`（默认 0）——大赛复现性好，但 `LocalJudgeBackend.complete` 里 `sampling=temp>0` 在 temp=0 时可能退化到贪心采样，注意与框架 `.chat()` 参数语义核对。

## 五、验证建议（Node 修复后）

```bash
# 前端（vitest 线程池模式，规避沙箱 fork 超时）
env -u NODE_OPTIONS node_modules/.bin/vitest run --pool=threads tests/unit/dimTracker.test.ts tests/unit/githubImportSafety.test.ts
# Python 单测（需 model-service 依赖环境）
cd model-service && python -m pytest tests/test_craft_judge.py tests/test_evaluate_run.py -q
# 端到端冒烟（配好 JUDGE_BACKEND=http 后）
curl -s http://127.0.0.1:8000/health   # 应看到 judge_available:true
```

## 六、附录：Node PATH 乱码修复（Windows）

**根因**：当 Windows 用户名含非 ASCII 字符时，PATH 里某些 AI 编程工具安装目录（含中文用户名）的 UTF-8 字节可能被按 GBK 解码后写回注册表，变成乱码路径；若该目录同时已不存在，PATH 里就没有任何可用 node。

**修复原则**：备份用户 PATH → 过滤掉已失效的工具目录条目 → 追加本机已验证可用的 node 路径 → 重开终端验证 `node -v`。改 PATH 一律用 `[Environment]::SetEnvironmentVariable`（.NET 写注册表是 Unicode 安全），避免第三方安装器或 `setx` 在 GBK 控制台里写 UTF-8 中文路径（`setx` 还会截断长 PATH）。

> 注：本附录原始版本含具体本机工具路径，已按隐私要求泛化；如需原始命令请查阅私有存档，参赛/公开材料一律使用本泛化版本。
