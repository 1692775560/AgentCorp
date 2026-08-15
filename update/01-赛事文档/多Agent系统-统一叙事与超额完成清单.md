# 多 Agent 系统：统一叙事 + 超额完成清单

> 面向问题：仓库里有两套多 Agent 实现，GOAI 讲的是弱的那套。怎么修，才能让初赛「超额完成」？
> 本次已完成的代码改动见文末「本次已交付」一节（全部实跑通过）。

---

## 一、问题的本质：不是「两套系统」，是「两个层没接起来」

原先看起来像两套竞争实现，实际上它们**在架构上是互补的两层**，只是没人把它们画在一张图上：

| | `src/demo/*`（GOAI 线） | `src/engine/squad/*`（产品线） |
|---|---|---|
| 干什么 | **治理**：谁能上线、谁来审批、留什么证据 | **执行**：真 LLM 拆解、并行干活、返工重做 |
| 类比 | 质检部 + 人事部 | 生产车间 |
| LLM | 可注入（真评委 / 确定性 mock） | 真 LLM（Ark / OpenAI 兼容） |
| 产物 | 六维分 + pass^k + 审批单 + Trace | 真实交付物 + A2aTraceRecord |
| 缺什么 | 缺真实执行 | 缺准入把关与审计 |

**结论：不该二选一，该串起来。** 串起来之后的完整故事是：

```
准入治理层（demo/*）              执行层（engine/squad/*）
┌─────────────────────┐          ┌──────────────────────┐
│ Boss     准入决策    │          │ Leader  真实拆解      │
│ Dispatcher 拆解编排  │  ──准入──▶│ Worker  并行执行      │
│ Recruiter 基线测试   │  ◀─回归──│ Leader  审阅返工      │
│ Evaluator 能力评估   │          │ Leader  汇总交付      │
│ ⛔ 审批门 + 回滚      │          │ 📋 A2A Trace 落盘     │
└─────────────────────┘          └──────────────────────┘
        ↑                                    │
        └────── 上线后 KPI 回归（metricsEngine）┘
```

**一句话叙事**：
> 「Agent 不是装上就完事。AgentCorp 管的是 Agent 的**整个雇佣周期**：
> 准入前测能力（Recruiter+Evaluator）、上线要审批（Boss+审批门）、
> 干活真协同（Leader+Worker 拆解/并行/返工）、干完留证据（Trace/审计）、
> 干得不好能回滚下线（补偿执行器）。」

这个叙事比「我们有 4 个 Agent 能跑通闭环」强得多，因为它对应的是**企业真实的治理生命周期**，
而且**每一段都有代码**。

---

## 二、本次已交付（全部实跑验证通过）

### ✅ 1. 审批门与回滚执行器（把「标签」变成「门」）

**新增** `src/demo/governance/approvalGate.ts`（约 400 行）

此前的致命问题：`boss_review` 产出 `{action:'rollback', requiresHumanAck:true}`，
但全仓没有任何代码消费它——`requiresHumanAck` 只在 UI 上被渲染成一行文字，
`rollback` 只是把 status 置成 failed。**那不叫审批与回滚，那叫审批与回滚的注释。**

现在实现的是真正的治理门：

| 能力 | 实现 | 验证 |
|---|---|---|
| **审批门** | 高风险动作（`requiresHumanAck=true`）**不执行**，落 PENDING 审批单，闭环挂起为 `awaiting_approval` | 实跑：hire 决策后录用台账为空 `[]` |
| **人工放行** | `decideApproval('approve')` 时才执行 `apply()` | 测试断言：放行前 `sink=[]`，放行后 `sink=['applied']` |
| **拒绝** | 动作永不执行 | 测试断言 |
| **幂等保护** | 已决策单拒绝重复决策（防高风险动作被重放执行两次） | 测试断言：重复 approve 后仍只执行一次 |
| **回滚执行器** | Saga 补偿模式，**逆序**执行已登记的补偿动作 | 测试断言：`['apply:A','apply:B','comp:B','comp:A']` |
| **半回滚暴露** | 单条补偿失败不中断其余，失败如实进 `failures` 而非被吞 | 测试断言：`reason` 含「半回滚状态」 |
| **不可补偿标注** | 未声明 compensate 的动作标为 `uncompensable`，不假装回滚成功 | 测试断言 |
| **审计流水** | 每次状态跃迁追加不可变审计条目（who/what/when/why），可导出 JSONL | 实跑输出真实 JSONL |
| **执行失败处理** | apply 抛错时审批单保持 pending 可重试，不进 approved | 测试断言 |

**实跑证据**（现场采集，可直接做 PPT 页）：

```
STATUS: awaiting_approval | pendingApprovalId: appr-msv161t4-rkio5a
  approve  blocked  老板决策：HIRE。六维全达标（pass^k allPass=true）…
                    （⛔ 已被审批门拦截，动作未执行，等待人工放行）
录用台账（应为空，因为未放行）: []
审批单: hire/pending/risk=high
审计JSONL:
  {"approvalId":"appr-…","runId":"run-…","action":"hire","targetId":"fe-07",
   "riskLevel":"high","requestedBy":"boss","state":"pending","actor":"boss",
   "reason":"申请执行高风险动作「hire」：…","ts":1786837928872}
```

**Demo UI 也已接入**：挂起时显示橙色审批卡片 + 「✅人工放行 / ✋拒绝」按钮 +
实时显示录用台账记录数（放行前 0，放行后 1）+ 审计流水面板。
**这是现场演示最有冲击力的一段：点「运行」→ 系统停住不动 → 说「看，它不敢自己录用」。**

新增测试 `tests/unit/approval-gate.test.ts`：**14 项全通过**。

### ✅ 2. HiClaw / AgentTeams CRD 导出（把「类型同形」变成「可核对产物」）

**新增** `src/demo/agentteams/hiclawCrd.ts` + `scripts/agentteams/export-hiclaw.mjs`
+ `pnpm agentteams:export`

此前的问题：`agentteams-adapter.ts` 自定义了 `ATAgent/ATTeam/ATTask/ATRun`，
形态上像 AgentTeams，但与 HiClaw 的真实 CRD（`hiclaw.io/v1beta1`，
Kind: Team/TeamAdmin/TeamLeader/Worker）命名、层级、字段都对不上。
熟悉 HiClaw 的评委一问「你到底怎么映射的」就答不上来。

现在一条命令导出**真正的 HiClaw 声明式清单**（`docs/artifacts/hiclaw-manifest.yaml`，
5 个 CRD 文档，已验证为合法 YAML）：

```yaml
apiVersion: hiclaw.io/v1beta1
kind: Team
metadata:
  name: "agentcorp-core"
spec:
  teamAdmin: boss           # 平台管控层
  teamLeader: dispatcher    # 业务协作层
  workers: [recruiter, evaluator]   # 执行层
  transport:
    current: "openclaw-gateway-ws-rpc"
    hiclawEquivalent: matrix
  credentials:
    current: "host-api-session-token（主进程持有，渲染层不可见）"
    hiclawEquivalent: "higress-consumer-token"
    principle: "worker-never-holds-real-credentials"
```

**并附迁移成本自查表**（命令行直接输出）：

| 关注点 | AgentCorp 现状 | HiClaw 目标 | 成本 |
|---|---|---|---|
| 组织结构声明 | ROLE_CARDS（TS 常量） | Team/TeamAdmin/TeamLeader/Worker CRD | 协议适配 |
| Skill 定义与调用 | Skill 注册表 + invokeSkill（含边界校验） | Worker.skills + HiClaw skill 调用 | 协议适配 |
| 通信底座 | gateway WS RPC + A2aTrace JSONL | Matrix（Tuwunel homeserver） | 配置替换 |
| 凭证托管 | Host API session token（主进程持有） | Higress AI Gateway + Consumer Token | 配置替换 |
| 人在回路审批 | approvalGate（门 + 补偿 + 审计流水） | HiClaw 群聊 @ 人工介入 | 协议适配 |
| 控制面 reconcile | 无（进程内编排） | hiclaw-controller | **需新增工程** |

**这张表就是「以 AgentTeams 为设计基点」的答案**：六个关注点里五个是协议适配/配置替换，
只有控制面需要新增工程。而且产物里写死了诚实边界
（「尚未在 HiClaw 控制面真实 reconcile」），并有测试断言这句话必须在。

新增测试 `tests/unit/hiclaw-crd.test.ts`：**7 项全通过**。

### ✅ 3. 经验沉淀持久化（修掉演示会翻车的坑）

`experienceStore` 默认内存态，刷新页面即清零——演示时刷新一次，
「沉淀→复用」回路就断了。现已新增 `createLocalStorageExperiencePersister()`
并在 Demo 注入（含配额超限/隐私模式的内存降级）。

### ✅ 4. Skill 调用证据造假修复

`closedLoop.ts:171` 原先给 decompose 步打了 `skill:'orchestrate'` 标签，
但该步从未调用过 `orchestrate`。已删除标签并加注释说明
「trace 上的 skill 字段只标注真实发生过的 Skill 调用，不作宣传性标注」。

### ✅ 5. 依赖隐患修复

- `@modelcontextprotocol/sdk@^1.27.1` 已显式声明进 `package.json`
  （此前靠 openclaw 传递依赖 + `shamefully-hoist` 侥幸编译，评委 clone 后可能直接挂）
- 新增 `model-service/requirements-dev.txt`（含 `httpx<0.28`），
  CI 同步更新。此前 `pip install -r requirements.txt && pytest` 会直接 4 个文件收集失败

---

## 三、验证结果（本次改动后重跑）

| 门禁 | 改动前 | 改动后 |
|---|---|---|
| 前端单测 | 633 passed | **654 passed**（+21） |
| GOAI 专项 | 45 passed / 7 文件 | **66 passed / 9 文件** |
| model-service pytest | 271 passed（需手动补 httpx） | **271 passed**（requirements-dev 一键装齐） |
| tsc 双配置 | 0 error | 0 error |
| eslint | 0 error | 0 error |
| `pnpm verify:goai` | PASS | **PASS** |

（`tests/unit/collectors.test.ts` 在沙箱内因缺 Electron 二进制而 fail，非代码问题。）

---

## 四、还没做、建议初赛诚实标注的

| 项 | 现状 | 建议表述 |
|---|---|---|
| 两层真实串联 | 治理层与执行层各自可跑，**尚未在一次 run 里端到端串联** | 「架构已对齐（同一套 RoleCard + Trace schema），串联为复赛工程项」 |
| pass^k 语义 | 当前测的是**裁判重测信度**，非 Agent 执行可靠性 | 见《方法论评估》文档，候选侧重跑通道（candidate_runner gateway 模式）已就绪 |
| HiClaw 真机 | 只到 CRD 形态对齐 | 产物里已写死此边界 |
| OTLP exporter | 只做了 OTel GenAI 语义投影 | 「语义层已对齐，接 exporter 为复赛项」 |
| 准则效度 | 无 | 复赛核心目标：准入评分 ↔ 上线后 KPI 相关性分析 |

---

## 五、PPT 该怎么改

原第 4 页「方案总览」的架构图，改成**两层一环**：

```
        ┌──────────── 准入治理层（4 Agent + Skill + 审批门）───────────┐
输入 ──▶ │ Boss ─ Dispatcher ─ Recruiter ─ Evaluator ─ ⛔审批门 ─ ↩回滚 │
        └────────────────────────┬───────────────────────────────────┘
                          准入通过 │            ▲ KPI 回归（劣化触发重评/下线）
                                  ▼            │
        ┌──────────── 执行层（Leader-Worker 真实协同）─────────────────┐
        │ Leader 拆解 → Worker 并行执行 → Leader 审阅返工 → 汇总交付    │
        └──────────────────────────────────────────────────────────────┘
                     全程 Trace 落盘 → OTel GenAI 投影
```

**新增一页（建议放在第 5 页 AgentTeams 映射之后）**：
「审批门现场演示」——三张截图：①点运行 ②系统停在 awaiting_approval、台账 0 条
③点放行后台账 1 条 + 审计流水。配一句：

> **「高风险动作不是打个标签就放行——它真的执行不了。」**
