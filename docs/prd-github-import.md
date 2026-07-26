# AgentCorp · 增量 PRD：GitHub 一键导入真实 Agent

> 产品经理：许清楚（Xu）　|　类型：**增量 PRD（简单 PRD）**　|　版本：v0.3-github-import　|　日期：2025-07-26
> 依据：PRD v0.2-marketplace（人才市场）· 架构 v0.2-marketplace（三 Tab）· `github-agent-import-research.md`（真实 agent 调研，本次主输入）
> 配套基线：`prd.md`(v0.1) · `prd-marketplace.md`(v0.2) · `architecture-marketplace.md`(v0.2) · `evaluation-design.md`

---

## 0. 文档定位（增量说明 · 务必先读）

| 项 | 说明 |
|---|---|
| 本文档性质 | 是 `prd-marketplace.md` v0.2 的**增量补充**，不是推翻重来 |
| **不改动** | 人才市场三 Tab 导航、卡片网格、筛选/搜索、详情抽屉、「挑选 → 入职评估 → 绩效中心（fire）」全流程、六维引擎、ROI/KPI、`fireAgent`、11 张 Mock 样例 |
| **新增** | 第 3 种 agent 来源：**GitHub 一键导入真实 agent**（来源值 `github_import`）；导入弹窗 + 前端直连 GitHub 公开 API + 启发式六维评分 + 并入市场列表 |
| 一句话增量目标 | **让人才市场里的员工是真实可验证的开源 agent，而非全手写 Mock，提升评委对「Agent 经济」的可信度与体感。** |
| 边界继承 | 模型推理（MiniCPM-o 真实多模态打分）仍由**朋友负责的模型服务**提供；本期 Mock 模式下用**启发式打分**替代六维 `initial_review`，仅留扩展点，不接真实模型 |

---

## 1. 产品目标（Product Goals）

> **主目标（一句话）**：让人才市场里的员工是真实可验证的开源 agent，而非全手写 Mock，提升评委可信度。

### 1.1 三个正交子目标

| # | 子目标 | 说明（正交、不重叠） |
|---|---|---|
| G1 | **真实可验证性** | 导入的 agent 来自 GitHub 真实仓库（stars/forks/license/README/示例均可查），卡片自带 ⭐ 数与协议标，从「手抄简历」升级为「可溯源履历」 |
| G2 | **零后端零依赖 Demo** | 前端直接调 `api.github.com`，无需自建后端；未认证 GET 支持 CORS；可选 token 输入框；完整跑通「粘贴 URL → 抓取 → 预览 → 导入 → 海选入职」 |
| G3 | **与既有市场同构** | 导入的 agent 直接映射成现有 `MarketplaceAgent`，与 11 张 Mock 并存于同一卡片网格，复用同一「挑选 → 入职评估（六维初审）→ 绩效（ROI/KPI/You are fired）」链路，不另起炉灶 |

### 1.2 衡量标准（可量化）

| 目标 | 衡量指标 |
|---|---|
| G1 | 导入 agent 卡片 100% 显示 ⭐ 数与协议标；非 MIT/Apache 协议 100% 标红「商用需复核」 |
| G2 | 单次 Demo 导入 ≤5 个仓库，未认证限速 60/h 不触顶；私库/限流/404 三类异常均友好提示且可 token 重试 |
| G3 | 导入 agent 可被「挑选」并进入 `onboard` Tab；六维初审/绩效（ROI/KPI/You are fired）链路与 Mock 卡完全一致可达 |

---

## 2. 用户故事（User Stories · 粘贴 → 预览 → 导入 → 海选）

> 格式：As a [角色], I want [feature] so that [benefit]

1. **As a 评委/采购者**, I want 在市场页点「导入 GitHub Agent」并粘贴 `github.com/<owner>/<repo>`, so that 我能把一个真实开源 agent 当场变成可挑的员工。
2. **As a 采购者**, I want 弹窗自动抓取仓库元数据并在「预览画像卡」里看到职能/风格标签/⭐数/协议标/六维小雷达, so that 我在导入前就判断这人值不值得进市场。
3. **As a 采购者**, I want 点「确认导入」后该 agent 立刻出现在市场卡片网格里（与 11 张 Mock 并存）, so that 我可以像挑其它卡一样「挑选 → 入职评估」。
4. **As a 采购者**, I want 导入失败（私库/404/限流）时看到明确提示并填 token 重试, so that Demo 不会因为一个坏仓库卡死。
5. **As a 治理者**, I want 导入的 GitHub agent 走和 Mock 完全相同的「六维初审 → 派任务跑 ROI/KPI → You are fired」流程, so that 真实 agent 也能被量化考核与淘汰。

### 2.1 主链路（一条端到端旅程）

```
粘贴 URL → 解析 owner/repo → 抓 GitHub 元数据/README/Release/目录
   → 映射成 MarketplaceAgent + 启发式六维 → 预览画像卡
   → 确认导入 → 合并进市场列表（与 Mock 并存）
   → 像普通卡一样「挑选」→ 入职评估（六维初审）→ 绩效中心（ROI/KPI/You are fired）
上传自有 Agent（既有）· 11 张 Mock（既有）────────┐并存在市场，统一经「挑选」汇入评估池
```

---

## 3. 需求池（P0 / P1 / P2）

> 优先级：P0=Must（答辩与复现必需）· P1=Should（提升完整度）· P2=Nice（加分/未来）。
> 所有新增均在既有 `MarketplaceAgent`/`store`/`components/Marketplace/*` 之上扩展，**不推翻**现有市场与评估链路。

### 3.1 P0（Must have）

| ID | 需求 | 说明 / 验收标准 | 复用/扩展点 |
|---|---|---|---|
| **P0-1** | **市场页「导入 GitHub Agent」入口** | 在 `MarketplacePanel` 头部与「上传自有 Agent」并列新增「导入 GitHub Agent」按钮，点击打开导入弹窗 | `MarketplacePanel.tsx` 头布局（参考 `UploadModal` 触发方式） |
| **P0-2** | **导入弹窗 + URL 解析** | 弹窗内粘贴 `github.com/<owner>/<repo>` 或完整 URL → 解析出 `owner/repo`（兼容 `.git` 后缀、尾斜杠、query/hash）；非法输入即时报错 | 新增 `ImportGitHubModal.tsx`（风格对齐 `UploadModal`） |
| **P0-3** | **前端直连 GitHub 公开 API 抓取** | 直接 `fetch('https://api.github.com/repos/{owner}/{repo}')` 等，**无需后端**；未认证 GET 支持 CORS；抓：`/repos/{o}/{r}`（name/description/language/license/star/fork/pushed_at/topics）、`/README.md`、`/releases/latest`、`/contents/`（找 examples/、docs/、showcase/、demo 视频作作品集素材） | 新增 `services/githubImport.ts`；注明未认证限速 60/h，预留可选 `token` 头 |
| **P0-4** | **映射成 `MarketplaceAgent`** | 直接复用现有类型（不另起炉灶）：`id/name←repo`；`tagline←description`；`agent_function←`人工预设 + README/Topics 关键词推断（poster/image→制图, video→短视频, research/report→文案, react/html→前端, issue/fix/backend→后端）；`style_tags←topics`；`work_thumbnails←`examples 下图片/视频；`source←'github_import'`（**需在 `AgentSource` 加此值**）；`license` 记入（非 MIT/Apache 标红「商用需复核」） | `types/marketplace.ts` 加 `'github_import'`；`githubImport.ts` 的 `mapRepoToAgent()` |
| **P0-5** | **启发式 Mock 评分（六维 `initial_review`）** | 从 GitHub 信号推导六维（star 量级→task/quality、examples/demo→creativity、license 宽松→cost、近期 pushed_at→reliability、README 详实度→comm）；算均值经 `deriveQuickVerdict` 给 `quick_verdict`（阈值 ≥4 PASS / ≥3.3 OBSERVE / <3.3 REJECT）；`profile.evaluation.radar` 与 `initial_review.radar` 同对象引用（沿用 Mock 约定） | 复用 `utils/marketFilter.ts` 的 `deriveQuickVerdict`；新增 `heuristicReview()` |
| **P0-6** | **并入市场列表 + 可挑选** | 导入成功后把 `MarketplaceAgent` 合并进 `marketAgents`（按 id 去重），与 11 张 Mock 并存；卡片「挑选」复用既有 `pickFromMarket` 直接进 `onboard` | `useAppStore` 增 `addImportedAgent(ma)`；`pickFromMarket` 零改动 |
| **P0-7** | **失败/限流/私库友好提示 + token 重试** | 三类异常友好提示：① 404 仓库不存在；② 403/限流（读 `X-RateLimit-Remaining`）→ 提示填 token；③ 私库/无权限（GitHub 对私库无 token 返回 404）→ 提示填 token 重试；弹窗内提供可选 token 输入框，带 token 用 `Authorization: Bearer` 重试已解析仓库 | `ImportGitHubModal.tsx` 错误态；`githubImport.ts` 带 `token` 重试 |

### 3.2 P1（Should have）

| ID | 需求 | 说明 / 验收标准 | 复用/扩展点 |
|---|---|---|---|
| **P1-1** | **卡片 GitHub 角标 + 作品集缩略可点开** | 导入卡显示「来源:GitHub + ⭐数 + 协议标」角标；`work_thumbnails` 缩略可点开大图/播放 demo 视频（复用 `MediaViewer`） | `MarketCard.tsx` 加 source 分支渲染；`AgentDetailDrawer.tsx` 已有缩略 |
| **P1-2** | **导入历史记录（localStorage）** | 已导入仓库 `owner/repo` 持久化到 localStorage，重进市场自动恢复，避免重复抓取与触发限流 | `useAppStore` + `githubImport.ts` 持久化层 |
| **P1-3** | **职能推断准确率优化** | 首批推荐 4+1 用人工预设职能白名单（见调研报告）；其余走关键词兜底；预览卡允许用户在确认前手动改职能/标签 | `githubImport.ts` 的 `inferFunction()` 预设表 + 兜底 |
| **P1-4** | **批量导入** | 支持一次粘贴多行 `owner/repo`（每行一个），批量抓取并预览多张画像卡 | 复用 `ImportGitHubModal` + `addImportedAgent` |

### 3.3 P2（Nice to have）

| ID | 需求 | 说明 | 复用/扩展点 |
|---|---|---|---|
| **P2-1** | **OAuth 导入私有库 / Issue 作履历** | 完整 GitHub App/OAuth 登录拿 `repo` 权限，导入私有仓库、拉 Issue/PR 作为「工作履历」 | 进阶通道（调研报告 §五.1） |
| **P2-2** | **真实 MiniCPM-o 评估替换启发式** | 朋友模型层就绪后，`githubImport.ts` 的 `heuristicReview()` 换为 MiniCPM-o 多模态评估（README 文本→文本通道、examples 图/视频→视觉通道），输出同构六维 | 仅留扩展点，本期不接 |
| **P2-3** | **与朋友 `/api/marketplace` 上传接口对齐** | 导入的 agent 可回传朋友真实市场库（上传接口），与 `getMarketplace()` 真实分支形成双向闭环 | `api.ts` 真实分支对接 |

### 3.4 P0 速览（给工程师的 checklist）

| 模块 | P0 需求 |
|---|---|
| 入口/弹窗 | P0-1（按钮）· P0-2（URL 解析）· P0-7（失败/token 重试） |
| 抓取/映射 | P0-3（GitHub API 直连）· P0-4（`MarketplaceAgent` 映射 + `'github_import'`） |
| 评分 | P0-5（启发式六维 + `deriveQuickVerdict`） |
| 落地 | P0-6（并入市场 + 可挑选） |

---

## 4. UI 设计稿（文字 + ASCII + Mermaid）

### 4.1 市场页头部：新增「导入 GitHub Agent」按钮位置

```
┌──────────────────────────────────────────────────────────────────────┐
│  AgentCorp · MiniCPM-o 全模态 HR 总监        [上传自有 Agent] [导入 GitHub Agent] │  ← 两个入口并列
│  ┌────────┬────────┬────────┐                                             │
│  │ 人才市场│ 入职评估│ 绩效中心│   ← 顶部 3 Tab（默认 market）                      │
│  └────────┴────────┴────────┘                                             │
├──────────────────────────────────────────────────────────────────────┤
│  筛选栏： [🔍 搜索]  职能: 全部|制图|短视频|文案|前端|后端   风格 ▾  报价 ▾  排序 ▾  │
├──────────────────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐                    │
│  │ 🖼 Mock  │  │ 🖼 Mock  │  │ 🐙 GitHub│  │ 🐙 GitHub│  ← 导入卡带 GitHub 角标     │
│  │ 琳图     │  │ 卡点小鹿 │  │ OpenHands│  │ GPT-Res  │                     │
│  │[制图]    │  │[短视频]  │  │[后端]⭐69k│  │[文案]⭐25k│                     │
│  │ ★4.3    │  │ ★4.4    │  │ ★4.1 MIT │  │ ★4.0 Apache│  ← ⭐数 + 协议标         │
│  │[查看][挑选]│ │[查看][挑选]│ │[查看][挑选]│ │[查看][挑选]│                     │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘                     │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.2 导入弹窗布局（ASCII）

```
┌─────────────────────────────────────────────────────────────┐
│ 导入 GitHub Agent                                  [✕ 关闭]   │
├─────────────────────────────────────────────────────────────┤
│ [🔗 粘贴仓库地址]                                            │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ github.com/All-Hands-AI/OpenHands   （支持完整 URL）       │ │
│ └─────────────────────────────────────────────────────────┘ │
│ [解析并抓取]   ▸ 高级： [显示 token 输入框 ▾]                  │
│                                                             │
│  ┌─ 可选 token（解除 60/h 限流 / 导入私库）──────────────┐  │
│  │ ghp_xxxxxxxxxxxx（仅本地使用，不落库）                │  │
│  └───────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  状态：⏳ 抓取中… / ✅ 解析成功 / ⚠️ 404 仓库不存在            │
│        / 🚫 限流(剩余0) 请填 token / 🔒 私库需 token          │
├─────────────────────────────────────────────────────────────┤
│  ┌─ 预览画像卡 ──────────────────────────────────────────┐  │
│  │ 🐙 OpenHands                       来源: GitHub ⭐69.2k  │  │
│  │ [后端] [前端]  #codeact #swe-bench #docker             │  │
│  │ 简介：自主软件工程 agent，改代码/跑命令/开 PR            │  │
│  │ 协议：MIT ✅可商用   （非宽松协议→🔴商用需复核）         │  │
│  │ ── 六维初审（启发式）──   quick_verdict: 初审通过       │  │
│  │ 小雷达 ▱ task4.5 quality4.3 comm4.0 creat4.2 rel5 cost5 │  │
│  │ 评价：["后端·CodeAct","MIT 可商用","⭐69k 高人气","近期活跃"]│ │
│  └───────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                              [取消]   [确认导入 → 市场]        │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 导入弹窗流程（Mermaid）

```mermaid
flowchart TD
  A[粘贴 github.com/owner/repo] --> B[解析 owner/repo]
  B --> C[GET /repos/{o}/{r}<br/>元数据+topics+license]
  C --> D[GET /README.md + /releases/latest + /contents/]
  D --> E[mapRepoToAgent<br/>映射 MarketplaceAgent]
  E --> F[heuristicReview<br/>启发式六维 + deriveQuickVerdict]
  F --> G[预览画像卡<br/>职能/标签/⭐/协议/六维雷达]
  G --> H{确认导入?}
  H -->|是| I[addImportedAgent 合并进 marketAgents]
  H -->|否| A
  C -.->|404 不存在| X[提示: 仓库不存在, 检查地址]
  C -.->|403 限流/私库| Y[提示: 填 token 重试]
  D -.->|限流| Y
  Y --> C2[带 Authorization: Bearer 重试]
  C2 --> C
```

### 4.4 导入后卡片 GitHub 角标（ASCII）

```
┌─ 卡片 card ─────────────────────────────┐
│ [🐙 emoji 色块]  OpenHands               │
│ 🔖 GitHub · ⭐69.2k · MIT ✅             │  ← 角标：来源+⭐+协议
│ [后端][前端]  #codeact #swe-bench         │
│ 报价 ¥260（推导）  ★初审 4.3             │
│ [查看详情]  [挑选 → 入职评估]            │
└─────────────────────────────────────────┘
```

> 说明：卡片复用现有 `MarketCard` 结构，仅新增 `source==='github_import'` 分支渲染「GitHub 角标 + ⭐数 + 协议标」；头像沿用职能 emoji 色块（与 Mock 一致），`avatar_url` 仅存不强制渲染，避免外链裂图。

---

## 5. 待确认问题（Open Questions · 不阻塞，需拍板）

> ⚠️ **已敲定、不再列为待确认**（用户已定，写入即生效）：① 前端直接调 GitHub 公开 API 无需后端；② 未认证限速 60/h + 可选 token 输入框；③ 抓取 `/repos`、`/README.md`、`/releases/latest`、`/contents/` 四类；④ 映射复用现有 `MarketplaceAgent` 及 `agent_function` 关键词推断规则；⑤ Mock 模式用启发式六维、`quick_verdict` 复用 `deriveQuickVerdict` 阈值、真实 MiniCPM-o 仅留扩展点；⑥ 导入后并入市场列表与 Mock 并存、可像普通卡挑选→入职→绩效；⑦ 失败/限流/私库需友好提示且可 token 重试。

1. **未认证限速 60/h 是否够 Demo**：单场 Demo 通常导入 ≤5 个仓库（调研首批 4+1），60/h 绰绰有余；但若评委反复试或多人轮番演示可能触顶。**推荐默认**：够用；超量时用可选 token（5000/h）兜底，并把导入结果 localStorage 缓存（P1-2），避免重复抓取。
2. **启发式打分公式的权重**：本文 §附A 已给默认分桶（star 量级→task、README 长度→quality/comm、examples→creativity、pushed_at→reliability、license→cost）。**推荐默认**：采用本文公式，先上 Demo 看体感再微调；后续 P2-2 由 MiniCPM-o 真评估覆盖。
3. **私库 token 是否本期做**：P0-7 已要求「可填 token 重试」，但完整 OAuth 登录是 P2-1。**推荐默认**：本期只做「粘贴 token 文本框 + 带 `Authorization: Bearer` 重试一次已解析的私有库/解除限流」，**不做**完整 OAuth 登录流程。
4. **`AgentSource` 加 `'github_import'` 是否破坏既有类型**：现状为 `"market_mock" | "user_upload"`。**推荐默认**：纯增量 union 扩展，不影响既有分支；仅 `MarketCard`/`AgentDetailDrawer` 的来源文案渲染需加一个 `github_import` 分支（显示「GitHub」而非「市场样例/用户上传」），零风险。
5. **导入 agent 的 `declared_budget`（报价）如何定**：GitHub 无报价字段。**推荐默认**：按 star 量级派生 notional 报价 `clamp(round(stars/2000)+100, 80, 320)`，后端/前端职能略加权，仅用于市场对比/排序，不承诺真实价格；卡片注明「推导价」。
6. **职能推断准确率**：纯关键词可能误判（如 MetaGPT 同时偏产品/后端/通用）。**推荐默认**：首批推荐 4+1 用人工预设职能白名单（调研报告确定），其余走关键词兜底，并允许用户在预览卡手动改职能后再「确认导入」（P1-3）。
7. **作品集缩略外链稳定性**：`raw.githubusercontent.com` 图片/视频用 `<img>/<video>` 标签可直接显示（不需 CORS）；但 GitHub 可能对高频访问限速。**推荐默认**：缩略直链 `raw.githubusercontent.com/<o>/<r>/<branch>/<path>`；若加载失败，`MediaViewer` 已有占位降级（与 Mock 一致）。

---

## 附A. 启发式六维打分（Mock 模式替代 MiniCPM-o · 实现要点）

输入信号：`S`=stars，`F`=forks，`L`=license.spdx_id，`M`=pushed_at 距今天数/30，`T`=topics，`R`=README 文本（长度 len），`E`=examples/showcase/docs 下是否找到图片或视频，`hasRelease`=`/releases/latest` 是否成功。

| 维度 | 公式（结果 clamp 到 [1,5]，保留 1 位） | 信号来源 |
|---|---|---|
| **task** 任务胜任力 | `starTier(S)`：`S≥50000→5, ≥20000→4.5, ≥8000→4, ≥3000→3.5, ≥1000→3, ≥200→2.5, 其余→2`；若该仓库主语言匹配导入职能（前端=TS/JS, 后端=Py/Go）→ +0.3 | stars + language |
| **quality** 产出质量 | `readmeTier(len)`：`len≥8000→4.5, ≥4000→4, ≥1500→3.5, ≥400→3, 其余→2.5`；`hasRelease→+0.3`；`E→+0.2` | README + release + examples |
| **comm** 表达沟通 | `readmeTier(len)-0.5`；有徽章/标题结构→ +0.3；`T.length≥5→+0.3`；有 docs/→ +0.2 | README + topics |
| **creativity** 创意差异化 | `E→4`（有 examples/showcase 图或视频）；有视频 demo→ +0.5；`T.length≥6→+0.3`；无素材→ 3 | examples/showcase |
| **reliability** 可靠性 | `M≤3→5, ≤6→4.5, ≤12→4, ≤24→3.5, ≤48→3, 其余→2.5`；`archived→×0.8`；`F≥1000→+0.2` | pushed_at + forks |
| **cost** 性价比/雇佣成本 | license 宽松度：`MIT/Apache-2.0/BSD/ISC/Unlicense→5`；`MPL-2.0/LGPL→3.8`；`GPL/AGPL→3.2`；`自定义/unknown/无协议→2.5`；`研究/非商业→2`（并标红「商用需复核」） | license |

- `confidence` = 可用信号数 / 6（README、license、topics、examples、release、pushed_at 是否齐全）。
- `quick_verdict` = `deriveQuickVerdict(mean of 6 dims)`（**复用 `utils/marketFilter.ts`**，阈值 ≥4 PASS / ≥3.3 OBSERVE / <3.3 REJECT）。
- `tag_eval` 由信号拼装，如 `["后端·CodeAct","MIT 可商用","⭐69k 高人气","近期活跃"]`。
- `profile.evaluation.radar` 与 `initial_review.radar` **同对象引用**（沿用 Mock 约定），入职评估复用同一六维；`profile.evaluation.verdict` 镜像 `quick_verdict`（PASS→MVP / OBSERVE→OBSERVE / REJECT→FIRED），`user_fit=0`。

---

## 附B. 增量文件与关键函数（给架构师/工程）

> 纯增量，不推翻既有；复用 `MarketplaceAgent` / `pickFromMarket` / `MarketCard` / `AgentDetailDrawer` / `deriveQuickVerdict`。

| 文件 | 动作 | 关键内容 |
|---|---|---|
| `src/types/marketplace.ts` | **改** | `AgentSource` 联合类型加 `'github_import'` |
| `src/services/githubImport.ts` | **新** | `parseRepoUrl()` / `fetchRepo(owner,repo,token?)` / `mapRepoToAgent()` / `heuristicReview()` / `inferFunction()`（预设白名单 + 关键词兜底） |
| `src/components/Marketplace/ImportGitHubModal.tsx` | **新** | 导入弹窗：URL 输入 → 加载态 → 预览画像卡 → 确认导入；错误态（404/限流/私库）+ token 输入框 |
| `src/components/Marketplace/MarketplacePanel.tsx` | **改** | 头部加「导入 GitHub Agent」按钮，触发 `ImportGitHubModal` |
| `src/components/Marketplace/MarketCard.tsx` | **改** | `source==='github_import'` 分支渲染「GitHub 角标 + ⭐数 + 协议标」 |
| `src/store/useAppStore.ts` | **改** | 增 `addImportedAgent(ma)`（合并进 `marketAgents`，按 id 去重）；`pickFromMarket` 零改动 |

**关键函数签名（建议）**

```typescript
// services/githubImport.ts
export function parseRepoUrl(input: string): { owner: string; repo: string } | null;
export async function fetchRepo(
  owner: string, repo: string, token?: string,
): Promise<GithubRepoRaw>;                 // 直连 api.github.com，带 token 则 Authorization 头
export function inferFunction(
  repo: GithubRepoRaw, preset?: AgentFunction,
): AgentFunction;                          // 预设白名单优先，否则关键词兜底
export function heuristicReview(repo: GithubRepoRaw): InitialReview;  // 附A 公式 + deriveQuickVerdict
export function mapRepoToAgent(
  repo: GithubRepoRaw, token?: string,
): MarketplaceAgent;                       // 组装 profile + initial_review（六维同源）
```

**GitHub API 抓取要点（准确性）**

- 元数据：`GET https://api.github.com/repos/{owner}/{repo}` → `full_name/name/description/language/stargazers_count/forks_count/pushed_at/topics/license{spdx_id}/owner.avatar_url/html_url`。
- README：`GET .../README.md`（`Accept: application/vnd.github.raw+json` 直接拿文本；或取 `content` base64 解码）。
- Release：`GET .../releases/latest`（无 release 返回 404，需 try/catch 降级）。
- 目录：`GET .../contents/` 取顶层；examples/showcase/docs 再发一次请求找 `*.png/*.jpg/*.gif/*.mp4`，转 `raw.githubusercontent.com/<o>/<r>/<branch>/<path>` 作 `work_thumbnails`。
- 限流：未认证 60/h，读响应头 `X-RateLimit-Remaining`；403 且剩余 0 → 限流提示；私库无 token → GitHub 返回 404（避免泄露存在性）→ 统一引导填 token。
- CORS：`api.github.com` 对 GET 支持 `Access-Control-Allow-Origin: *`；`raw.githubusercontent.com` 图片/视频用 `<img>/<video>` 显示无需 CORS。

---

## 6. 风险与边界（增量视角）

| # | 风险 / 边界 | 缓解（产品/工程） |
|---|---|---|
| RG1 | 限流导致 Demo 卡死 | 可选 token（5000/h）+ localStorage 缓存（P1-2）+ 友好提示；单场导入 ≤5 不触顶 |
| RG2 | 私库/坏地址误导入 | URL 解析校验 + 404/限流/私库三态提示 + token 重试；不静默失败 |
| RG3 | 职能误判拉低可信度 | 首批 4+1 预设白名单 + 预览卡手动改职能（P1-3）；关键词兜底透明展示 |
| RG4 | 导入卡与 Mock 卡割裂 | 严格复用 `MarketplaceAgent` 同构 + `pickFromMarket` 零改动，入市场后全链路一致 |
| RG5 | 真实 MiniCPM-o 评估缺失 | 本期仅启发式 + 扩展点（`heuristicReview` 可整体替换为模型调用），不阻塞答辩 |
| RG6 | 外链缩略裂图 | `MediaViewer` 占位降级（与 Mock 一致）；头像用职能 emoji 色块不强制外链 |

---

*— 增量 PRD v0.3-github-import 完。本文档聚焦「GitHub 一键导入真实 Agent」新增能力，复用现有 `MarketplaceAgent`/卡片/市场/入职/绩效，不推翻人才市场既有设计；已敲定 7 项不再列入待确认，待确认项见 §5（均附推荐默认值）。*
