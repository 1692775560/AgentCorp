# Arena 个性化对决 + 用户参与机制 设计说明

日期：2026-08-08 · 架构师：Bob · 状态：待评审
配套契约文档：`docs/api/contracts.md`（本设计的所有接口均以该文档为唯一契约真相）。

---

## 1. 背景与设计目标

AgentCorp 已有：闭卷标准化试做题（`craft_tasks`，参考答案锚定 + 反注水探针）、LLM-as-judge 裁判（`craft_judge`，同题同 rubric、hit 必须 quote）、双通道跑题（`candidate_runner`：text/gateway）、HR 面试三阶段（`interview.ts` + `dimTracker`）。

本期新增 4 项能力，核心是把「客观标准化评测」扩展为「基于用户需求的个性化比较 + 用户深度参与」：

1. **Arena 个性化对决**：用户输入需求 → 同工种 N 个 agent 作答 → 双轨评判（LLM 客观分 + 用户主观选择）→ Elo 更新。
2. **面试用户自定义题**：S2 面试流内嵌「无参考答案」的用户题，复用 Arena 跑题与选择通道。
3. **最受 boss 青睐奖**（per 工种）：测评后深度认可投票 + 工种赛道徽章。
4. **小红心点赞**：卡片左下角点赞/取消 + 计数 + 个人态持久化。

---

## 2. Arena 个性化对决（核心设计）

### 2.1 流程总览

```
用户输入需求文本（自然语言）
  → ① 题面化：需求文本 + 工种模板 → task_prompt（确定性函数，无 LLM）
  → ② 选角：同工种 2..N 个 agent（candidate 引用）
  → ③ 跑题：candidate_runner 逐 agent 作答（复用）
  → ④ 客观轨：arena_judge（新 prompt，复用 judge_backend + 解析铁律）逐答案打分
  → ⑤ 组装 ArenaMatch（pending）→ 返回对比视图数据
  → ⑥ 用户主观选择（pick: winner / draw / none）
  → ⑦ 胜负判定 + Elo 更新（纯函数 elo.py）→ 回填 match
```

### 2.2 需求 → 题面：直接以需求为题干 + 工种模板包装（决策 D1）

**方案**：不把需求交给 LLM 改写成结构化任务；而是「用户原话 = 题干主干」+「按工种确定性模板」包装成可作答题面。

**论证**：
- **透明性**：用户能直接看到 agent 面对的是自己的原话，主观判断（差异化核心）才有依据；LLM 改写会引入「改写者视角」，破坏用户对题面的掌控感。
- **简单可靠**：模板是纯函数（无 LLM 调用），零延迟、零 token、零改写偏差，且可单测。
- **可比性由裁判保证而非题面**：craft_tasks 的公平来自「同题 + 参考答案锚定」；个性化题无标准答案，公平改由「同需求 + 同工种模板 + 同 rubric 裁判」保证。
- **反注水延续**：模板内嵌工种探针（「给出可执行内容，不要空话」「一句话说明如何验证」），复用 craft_judge 的 padding 检测理念。

模板结构（`arena_templates.py` 纯数据）：

```
【任务背景（用户原始需求）】
{requirement_text}
【任务要求】
- 请基于上述需求给出你的实施方案/产出（按工种）：
  - code : 方案要点 + 核心代码/伪代码 + 你会写的测试
  - text : 文案初稿 + 措辞依据
  - image: 可执行参数（构图/色板/光线）+ 正向/负向提示词
- 直接针对需求作答，不要泛泛介绍自己；空话将被判定为注水。
- 用一句话说明你如何验证方案有效。
```

### 2.3 双轨评判（决策 D2）

| 轨 | 谁评判 | 产出 | 用途 |
|---|---|---|---|
| 客观轨 | LLM-as-judge（`arena_judge.py` 新 prompt） | craft 维 dims（0–5）+ checkpoints(hit+quote) + padding + confidence + **需求贴合分 fit（0–5）** | 展示、客观 Elo（辅榜）、辅助用户决策 |
| 主观轨 | 用户 | `pick ∈ {agentId, draw, none}` | **最终胜负依据**（差异化核心）、主观 Elo（主榜） |

客观轨复用：`judge_backend`（唯一推理入口/门禁）、`_extract_json` 解析、越界维丢弃、未覆盖维不进分、hit 必须 quote。**不复用** `craft_judge.SYSTEM_PROMPT`（其含参考答案锚定与题库 rubric 语义），新写 `arena_judge.SYSTEM_PROMPT`：维度限定 `JOB_CRAFT_DIMS[job_type]` 子集 + `fit` 维；同需求对所有 agent 用同一份 rubric 文本（不按答案个性化）。

### 2.4 数据模型（ArenaMatch）

```python
# model-service/app/schemas.py 追加（pydantic，camelCase 经 Host API 代理）
class ArenaCandidateAnswer(BaseModel):
    agent_id: str
    agent_name: str = ""
    answer_text: str
    channel: str = ""                     # text / gateway
    latency_ms: float = 0.0
    judgement: Optional[dict] = None      # arena_judge 输出（dims/checkpoints/padding/confidence/fit）
    objective_total: float = 0.0          # 客观分汇总（dims 均值 + fit 加权，规则见 2.5）

class ArenaMatch(BaseModel):
    match_id: str
    context: Literal["arena", "interview"] = "arena"
    interview_id: Optional[str] = None    # context=interview 时关联
    requirement_text: str
    task_prompt: str                      # 模板渲染后的完整题面
    job_type: str
    candidates: List[ArenaCandidateAnswer]
    objective_leader: Optional[str] = None  # LLM 分最高者
    user_pick: Optional[str] = None       # agent_id | "draw" | "none"
    status: Literal["pending", "picked", "abandoned"] = "pending"
    elo_delta: Dict[str, float] = Field(default_factory=dict)  # pick 后回填
    created_at: str = ""
    picked_at: Optional[str] = None
```

### 2.5 胜负判定与 Elo 规则（决策 D3，`elo.py` 纯函数）

**纯函数**（零依赖、可单测）：
```
expected(r_a, r_b) = 1 / (1 + 10 ** ((r_b - r_a) / 400))
update(rating, expected_score, actual_score, k) = rating + k * (actual_score - expected_score)
```

**两套 Elo（同库不同键）**：
- **主观 Elo（主榜）**：`score_A = 1/0.5/0`（win/draw/lose）；`none`（都不满意）→ 不更新，记为无效对局（防刷分）。
- **客观 Elo（辅榜，可选）**：LLM 分差归一化为胜率分数 `score_A = 1/(1+10**((obj_B-obj_A)/2.0))`，避免分差小时硬判胜负。

**k-factor 与用户权重**：
- 主观 k=16（用户判断波动大）、客观 k=8；初始 rating=1000，钳制 [100, 3000]。
- `user_weight ∈ (0,1]` 作为 k 的乘数（`k' = k * user_weight`）：本地单人版默认 1.0；契约预留 `ownerId/weight` 字段，未来后端接入用户可信度/活跃度。

**防滥用（本地版）**：
1. **幂等**：同一 `match_id` 只允许一次 pick；重复 pick 返回 409。
2. **未完成去重**：同需求 + 同对 agent 存在 pending match 时，compare 返回已有 match_id（不重复跑题）。
3. `none` 不计 Elo；`draw` 双方 +0.5 处理（小幅波动）。
4. 同一 agent 每天最多参与 50 场对决（本地计数，契约预留后端限流）。

### 2.6 端到端接口

- `POST /api/arena/compare`：`{requirement_text, job_type, candidates:[candidate_ref]}` → 模板题面化 → 逐 agent `run_candidate` → 逐答案 `arena_judge` → 组装 `ArenaMatch(pending)` 返回对比视图。错误：404（未知工种/候选通道）、422（缺参/空需求）、502（跑题失败）、503（judge 后端不可用）。
- `POST /api/arena/user-pick`：`{match_id, pick}` → 校验 → 胜负判定 + 双轨 Elo 更新 → 回填 `user_pick/status/elo_delta/picked_at` → 返回结果。409 重复 pick。
- 前端经 Host API `127.0.0.1:3210` 代理（新增 `electron/api/routes/arena.ts` 转发至 model-service，鉴权 `x-clawx-host-session`）。

### 2.7 与 craft-judge 的边界（决策 D4）

| 维度 | craft-judge（已有） | arena_judge（新增） |
|---|---|---|
| 题源 | 闭卷题库（固定题面） | 用户需求（开卷个性化） |
| 参考答案锚定 | 有（满分=5.0） | **无**（无标准答案） |
| 评分语义 | 标准化能力 | 需求贴合度 |
| 裁判 prompt | craft_judge.SYSTEM_PROMPT | arena_judge.SYSTEM_PROMPT（新增） |
| 共享设施 | judge_backend / candidate_runner / 解析铁律 / registry / aggregate_craft_dims | 同左 |

**边界规则**：Arena 的客观分**不回写** StageScore / EvaluationProfile（语义不同，避免污染标准化成绩）；Arena 结果独立存 `agentcorp.arena`（electron-store）+ 模型服务进程内 match 缓存。

---

## 3. 面试用户自定义题（无参考答案）

**设计**：不新增 phase（三阶段顺序不可破坏）；在 P2/P3 之后提供可选环节「用户自定义题」，作为**独立小节**挂到面试报告上，不进 `turns[]`（turns 是「一问一答 + HR 评分」结构，用户题是多 agent 对决，结构不同）。

**数据模型**（`src/types/interview.ts` 仅加法）：

```ts
interface UserQuestionRound {
  question: string;                       // 用户按自己实际情况出的题（无参考答案）
  matchId: string;                        // 复用 Arena 通道（context='interview'）
  candidates: { agentId: string; agentName: string; answerText: string }[];
  pick: string | 'draw' | 'none' | null;  // 用户主观判断
  note?: string;
  ts: string;
}
// InterviewReport 追加可选字段：
userQuestionRound?: UserQuestionRound;
```

**关键决策（决策 D5）**：
- **不进 dimTracker 证据**：用户题无标准答案、无 rubric 维度，不能产生客观六维证据；dimTracker 覆盖度仅反映标准化三阶段。
- **不进模型分，只进用户偏好**：用户主观判断是唯一标准；可选展示 `arena_judge` 客观分作参考，但**不写入 StageScore.objective**。用户选择可落为偏好信号（未来回灌 `PreferenceProfile`），并可作为 BossFavorite 的触发来源。
- **复用**：`POST /api/arena/compare`（`context:'interview'` + `interviewId`）、`POST /api/arena/user-pick`、`candidate_runner` 跑题、Elo（计入主观 Elo）。

---

## 4. 最受 boss 青睐奖（per 工种）

**语义（决策 D6）**：BossFavorite = **测评后深度认可**（完成面试/绩效/Arena 对决后对该工种某 agent 投一票）；小红心 = **浏览点赞**（卡片左下角）。二者语义分层，共用存储层。

**数据结构**（`src/types/reactions.ts` + `electron-store` namespace `agentcorp.reactions`）：

```ts
interface BossFavoriteVote {
  agentId: string;
  jobType: JobType;
  votedBy: string;                        // 本地 = 'default'；预留多用户
  stage: 'interview' | 'performance' | 'arena';
  ts: string;
}
interface FavoriteAggregate {             // 按 (jobType, agentId) 聚合
  count: number;
  voters: string[];                       // 预留：user_ids 集合
  updatedAt: string;
}
```

**本地单人版聚合**：count = 该 agent 在工种下收到的投票数（同一用户多次测评可重复投；防滥用：一次测评最多投一票，接口幂等——同 agent + 同 stage + 同 interviewId 不可重复）。本地 count 区分度来自「不同测评/不同 agent 间的比较」，配合 Top1/Top3 排名。

**展示**：工种赛道（code/text/image）顶部显示「最受 boss 青睐」徽章（Top1）或 Top3 排名；卡片内嵌 `BossFavoriteBadge`。

**接口**：`GET /api/favorites?jobType=`（本地聚合）、`POST /api/favorites/vote`（本地落库 + 幂等校验）。

---

## 5. 小红心点赞

**本地实现（决策 D7）**：`electron-store` namespace `agentcorp.reactions`（lazy-load 模式，同 `interviewStore.ts`）；`zustand` store（`likesStore.ts`）做内存镜像 + 乐观更新。不采用 localStorage：与现有面试报告落库模式一致，且未来可直接迁移到后端。

```ts
interface LikeRecord {
  agentId: string;
  count: number;
  likedByMe: boolean;                     // 本地个人态
  users: string[];                        // 契约预留：未来后端聚合 user_ids
  updatedAt: string;
}
```

**接口契约**（本地实现于 Host API `electron/api/routes/reactions.ts`）：
- `GET /api/likes/:agentId` → `{agentId, count, likedByMe, users?, updatedAt}`；未点赞记录返回 count=0。
- `POST /api/likes/:agentId/toggle` → 点赞/取消 + 计数 ±1 + 个人态翻转，返回最新记录；幂等（连续 toggle 正常翻转）。
- 契约注明：`users`/`ownerId`/`ts` 为**后端聚合预留字段**，当前本地实现 `users` 恒空、`likedByMe` 恒为本地态。

---

## 6. 接口契约文档框架

完整表格见 `docs/api/contracts.md`，覆盖三大功能域（人才市场 / HR 面试 / 绩效考核）+ 评测基础设施（judge / craft / chat / arena / likes）。每个端点标注：方法、路径、鉴权（Host API 代理说明）、请求/响应 schema、错误码语义（404/422/502/503）、gate（judge 可用性）、前端调用方文件、**本地实现 vs 契约预留**。

---

## 7. 任务分解（工程师执行，≤5 任务）

见文末附录 A（与回传主理人版本一致）。

---

## 8. 关键决策理由汇总

| # | 决策 | 理由 |
|---|---|---|
| D1 | 需求原文作题干 + 工种模板，不做 LLM 改写 | 透明性（用户看到自己的原话）、零改写偏差、模板可单测；可比性由「同题同 rubric 裁判」保证 |
| D2 | 双轨评判：LLM 客观分 + 用户主观选择 | 客观分提供可量化对比与防呆，用户选择是需求贴合度的最终真相（差异化核心） |
| D3 | 用户主观选择驱动主观 Elo（k=16），none 不计分，match 幂等 | 防止刷分/重复对决；主观判断波动大故 k 大于客观轨 |
| D4 | Arena 客观分不回写 StageScore | 语义不同（需求贴合 vs 标准化能力），避免污染标准化成绩 |
| D5 | 用户题不进 dimTracker、不进模型分 | 无标准答案无 rubric，不能产生客观证据；用户偏好是唯一输出 |
| D6 | BossFavorite=测评后认可，Like=浏览点赞，共用 reactions 存储 | 语义分层清晰；同一存储骨架（count + 个人态 + 预留 users[]）便于未来后端化 |
| D7 | 本地持久化用 electron-store（非 localStorage） | 与既有落库模式一致；可无缝迁移后端聚合 |

## 9. Anything UNCLEAR（待确认）

1. **Arena 入口位置**：独立页面（`/arena`）还是嵌入人才市场页？设计默认独立页 + 市场卡「对决」快捷入口。
2. **Elo 是否参与市场排序**：设计默认 Elo 仅展示（「竞技场评分」），不混入 matchScore；若需参与需另评审。
3. **面试用户题触发时机**：默认在 P3 结束后由 HR 主动发起；是否允许中途插入待确认。
4. **BossFavorite 投票来源**：默认面试/绩效/Arena 完成后均可投；投票窗口与频率上限待产品确认。

---

## 附录 A：任务分解

### T01 数据层与基础设施（契约底座 + 本地存储 + Host API 骨架）
- **文件**：`model-service/app/schemas.py`（追加 Arena/Like/Favorite 模型）、`src/types/arena.ts`（新建）、`src/types/reactions.ts`（新建）、`src/services/reactionStore.ts`（新建，electron-store lazy-load）、`electron/api/routes/reactions.ts`（新建，likes/favorites 本地实现）、`electron/api/routes/arena.ts`（新建，Host API 转发骨架）、`electron/api/server.ts`（注册 handlers）、`tests/`（schema 与 reactionStore 测试）
- **依赖**：无　**优先级**：P0
- **要点**：契约先行；reactions 本地读写 `agentcorp.reactions`；arena 转发先返回 501 占位（待 T02）。

### T02 Arena 后端（模型服务）
- **文件**：`model-service/app/scoring/elo.py`（新建，纯函数）、`model-service/app/scoring/arena_templates.py`（新建，工种模板）、`model-service/app/scoring/arena_judge.py`（新建，裁判 prompt + 解析）、`model-service/app/routes/arena.py`（新建，compare/user-pick）、`model-service/app/serve.py`（注册 router）、`model-service/tests/test_arena.py`（新建，elo + 流程 mock 测试）
- **依赖**：T01　**优先级**：P0
- **要点**：复用 judge_backend/candidate_runner/解析铁律；compare 幂等去重；user-pick 双轨 Elo。

### T03 Arena 前端（对决体验）
- **文件**：`src/services/judgeClient.ts`（追加 arenaCompare/arenaUserPick）、`src/stores/arenaStore.ts`（新建）、`src/pages/Arena/ArenaPage.tsx`（新建）、`src/components/arena/ArenaSetupPanel.tsx` + `ArenaCompareView.tsx` + `ArenaPickBar.tsx`（新建）、`src/App.tsx`（路由注册）、`src/stores/__tests__/arenaStore.test.ts`
- **依赖**：T01、T02（契约先行，可 mock 并行）　**优先级**：P0
- **要点**：需求输入 → 选角 → 双轨结果对比视图 → pick → Elo 展示；后端不可用降级提示。

### T04 面试用户自定义题
- **文件**：`src/types/interview.ts`（追加 UserQuestionRound）、`src/stores/interview.ts`（追加 addUserQuestion/pickUserQuestion）、`src/components/interview/InterviewThread.tsx`（环节入口）、`src/components/interview/UserQuestionPanel.tsx`（新建）、`src/services/interviewStore.ts`（落库扩展）、`src/stores/__tests__/interview.userQuestion.test.ts`
- **依赖**：T01、T03　**优先级**：P1
- **要点**：复用 arena 通道（context='interview'）；不进 dimTracker/不进模型分。

### T05 小红心 + BossFavorite（市场页集成）
- **文件**：`src/components/marketplace/MarketCandidateCard.tsx`（左下角红心 + 徽章）、`src/components/marketplace/BossFavoriteBadge.tsx`（新建）、`src/stores/likesStore.ts`（新建，乐观更新）、`src/stores/marketplace.ts`（装配 likes/favorite 视图字段）、市场页工种赛道（「最受青睐」展示）、`src/stores/__tests__/likesStore.test.ts`
- **依赖**：T01　**优先级**：P1
- **要点**：本地即时反馈（乐观更新 + 回滚）；契约字段预留后端聚合。

### 依赖图
```
T01 ──→ T02 ──→ T03 ──→ T04
  └──────────────→ T05
```
