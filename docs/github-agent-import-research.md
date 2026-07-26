# AgentCorp 人才市场 · GitHub 真实可导入 Agent 调研

> 用途：为「一键导入 GitHub agent 当员工」功能提供真实候选项与接入映射。
> 配合 `src/services/api.ts` 的 `getMarketplace()` 真实分支（预留 `/api/marketplace`）与 `MarketplaceAgent` 契约使用。

## 一、概览

GitHub 上已形成一个"可当员工导入"的真实开源 agent 生态：既有 MIT/Apache 协议、可直接商用修改的工程型 agent（OpenHands、Aider、SWE-agent、MetaGPT），也有带清晰 README + 示例/作品集 + 公开 CLI/API 的"简历素材型" agent（GPT Researcher、Jaaz、screenshot-to-code、OpenManus），足以覆盖制图、短视频、文案、前端、后端、通用六类职能，且多数近 1–2 年高度活跃（star 从 1.9 万到 17.8 万）。

## 二、按职能分组的候选项

| # | 仓库 | 一句话定位 | 员工职能 | 协议 | 活跃度(star) | 导入度 |
|---|------|-----------|---------|------|------|------|
| 1 | [OpenHands](https://github.com/All-Hands-AI/OpenHands) | 自主软件工程 agent（CodeAct 架构，改代码/跑命令/PR） | 后端/前端 | MIT | 极活跃(≈69k+) | ★★★★★ |
| 2 | [Aider](https://github.com/Aider-AI/aider) | 终端 AI 结对编程，深度绑定 git | 后端/前端 | Apache-2.0 | 极活跃(≈37–42k) | ★★★★ |
| 3 | [SWE-agent](https://github.com/SWE-agent/SWE-agent) | 自主修 GitHub issue/找漏洞（ACI 架构） | 后端 | MIT | 活跃(≈19k) | ★★★★ |
| 4 | [screenshot-to-code](https://github.com/abi/screenshot-to-code) | 截图/设计稿→HTML/React/Vue 代码 | 前端/UI | MIT | 极活跃(≈72–73k) | ★★★★★ |
| 5 | [MetaGPT](https://github.com/geekan/MetaGPT) | 多角色"软件公司"，一句话出 PRD/设计/代码 | 通用/产品 | MIT | 极活跃(≈69k) | ★★★★★ |
| 6 | [OpenManus](https://github.com/mannaandpoem/OpenManus) | Manus 开源平替，通用任务自主执行 | 通用 | MIT | 极活跃(≈42–55k) | ★★★★★ |
| 7 | [GPT Researcher](https://github.com/assafelovic/gpt-researcher) | 自主深度研究，输出带引用长报告 | 文案/研究 | Apache-2.0/MIT | 极活跃(≈24–28k) | ★★★★★ |
| 8 | [CrewAI](https://github.com/crewAIInc/crewAI) | 角色扮演多 agent 编排框架 | 通用/内容 | MIT | 极活跃(≈40k) | ★★★★ |
| 9 | [CAMEL / OWL](https://github.com/camel-ai/owl) | 通用多 agent workforce，GAIA 69.7% | 通用/研究 | Apache-2.0 | 活跃(≈17k) | ★★★ |
| 10 | [AutoGPT](https://github.com/Significant-Gravitas/AutoGPT) | 完全自主任务 agent（可视工作流） | 通用/文案 | 自定义(可商用) | 极活跃(≈178k) | ★★★ |
| 11 | [BabyAGI](https://github.com/yoheinakajima/babyagi) | 极简任务分解/优先级闭环 | 通用(教育) | MIT | 低(已归档) | ★★ |
| 12 | [Jaaz](https://github.com/11cafe/jaaz) | AI 设计 agent：出图/海报/故事板画布 | 制图/设计 | MIT | 活跃(2025 新兴) | ★★★★★ |
| 13 | [PosterAgent(Paper2Poster)](https://github.com/Paper2Poster/Paper2Poster) | 论文/文字→顶会级学术海报 | 制图/设计 | 研究(详查) | 活跃(2025) | ★★★ |
| 14 | [VideoAgent](https://github.com/HKUDS/VideoAgent) | 视频理解/剪辑/重制一体化 agent | 短视频 | 研究(详查) | 活跃(2026-06) | ★★★ |
| 15 | [UniVA](https://github.com/univa-agent/univa) | 通用视频 agent（规划-执行，MCP 工具链） | 短视频 | 研究(详查) | 极活跃(2025-11) | ★★★ |
| 16 | [Pixelle-Video](https://github.com/rackyun/Pixelle-Video) | AI 全自动短视频引擎（脚本→成片） | 短视频 | MIT | 活跃(2025-12) | ★★★★ |

> 协议提示：视频/海报类部分含研究论文权重或非商业数据集条款，商用前需核 LICENSE 与模型权重许可。

## 三、各候选的"简历素材"（MiniCPM-o 能评估什么）

- **OpenHands**：README 含架构图、SWE-bench 解决率、GAIA、Release 版本、示例对话与 PR 截图 → 评估"工程能力/可靠性/产出样例"。
- **Aider**：README 含 screencast、支持语言清单、git diff 示例、用户好评 → 评估"协作习惯/提交规范"。
- **SWE-agent**：NeurIPS 2024 论文、benchmark 数据、YAML 配置样例 → 评估"学术背书/可控性"。
- **screenshot-to-code**：README 内嵌复刻 demo 视频、多框架输出示例 → 评估"UI 还原度/前端审美"（最适合作图+前端双职能）。
- **MetaGPT**：一句话需求→PRD/竞品分析/API/架构图/代码 的完整产物链 → 评估"产品经理+工程师复合能力"，简历素材最丰富。
- **OpenManus**：实时思维链可视化、工具调用日志、任务回放 → 评估"自主规划/过程透明度"。
- **GPT Researcher**：输出带引用的 2k+ 字报告、PDF/Docx 导出 → 评估"研究深度/信息可信度"，报告即现成简历作品集。
- **CrewAI**：角色/Backstory/Goal 定义范式、企业落地案例 → 评估"团队角色适配度"。
- **Jaaz**：画布实操案例、海报/故事板生成示例 → 评估"设计产出/创意迭代"。
- **VideoAgent/UniVA/Pixelle-Video**：demo 视频、分镜脚本、成片样例 → 评估"视频叙事/剪辑质量"（素材为视频，全模态直接看片）。

## 四、推荐首批导入（职能覆盖最完整、MIT/Apache + README/示例齐全 + 有 CLI/API）

1. **OpenHands** — 后端/前端工程师（69k+ star、MIT、有 SDK 与 Docker，最像真实在职工程师）
2. **GPT Researcher** — 内容/研究专员（产物是带引用研究报告，天然简历）
3. **Jaaz** — 设计/制图（最纯粹的"设计师员工"，素材图文易评估）
4. **MetaGPT** — 通用/产品负责人（多角色产物链，简历素材极丰富）
5. 备选：**screenshot-to-code**（偏前端 UI）/ **Pixelle-Video**（偏短视频）/ **OpenManus**（偏通用噱头）

> 视频类（VideoAgent/UniVA）建议放第二批：偏研究框架、依赖外部视频模型 API，但作为"作品集视频"给 MiniCPM-o 看片评估效果出彩。

## 五、一键导入 GitHub Agent 技术步骤

### 1. 两种通道
- **URL 粘贴导入（推荐首批）**：用户输入 `github.com/<owner>/<repo>`，后端拉取解析。
- **OAuth / GitHub App 导入（进阶）**：拿 `repo` 权限，可导入私有仓库、拉 Issue/PR 作"工作履历"、订阅 Release 自动更新档案。

### 2. URL 粘贴抓取流水线
```
repo URL
 → GET /repos/{owner}/{repo}           取 name/description/language/license/star/fork/pushed_at/topics
 → GET /repos/{owner}/{repo}/README.md 简历正文
 → GET /repos/{owner}/{repo}/releases/latest
 → GET /repos/{owner}/{repo}/contents/ 找 examples/ demo*.mp4 docs/ showcase/
 → 可选: /contributors /commits        活跃度证据
 → 可选: Topics + README 关键词推断职能标签
```

### 3. 映射成 MarketplaceAgent 字段
| 字段 | 来源 |
|---|---|
| id / name | repo name |
| avatar | owner avatar 或 README 首图 |
| tagline | repo description |
| functions（职能） | 人工预设 + README/Topics 关键词推断（poster/image→制图，video→短视频，research/report→文案，react/html→前端，issue/fix/backend→后端） |
| capabilities | README Features 段 + 示例/产物类型 |
| license | license.spdx_id（非 MIT/Apache 标红商用风险） |
| popularity | stargazers_count + forks_count |
| last_active | pushed_at |
| resumeAssets（给 MiniCPM-o 的素材） | README 文本 + release notes + examples 下图片/视频 URL |
| importMethod | URL / OAuth |
| runnable | 是否含 Dockerfile/pyproject/install 步骤 |
| apiAvailable | 是否提供 CLI/Python API/REST |

### 4. 给 MiniCPM-o 评估接线
- `resumeAssets` 文本喂文本通道、图片/视频喂视觉通道 → 输出六维评分卡。
- 视频类直接传 demo 成片 URL 给 MiniCPM-o 看片，产出"视频叙事/剪辑"维度评语（全模态差异化亮点）。
- 协议非 MIT/Apache 在卡片打"商用需复核"标，体现 HR 总监合规治理人设。
