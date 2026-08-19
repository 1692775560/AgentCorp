# 设计文档 · 评测数据持久化与报告导出（#3）

> 状态：已设计，未实现。本文是可直接开工的规格说明。
> 关联问题：代码审阅报告 P1-3「评测结果无持久化」。

## 1. 问题

当前 `model-service` 的评分与榜单状态全部在进程内存里：

```python
# app/routes/leaderboard.py
_STAGE_STORE: dict = {}        # 重启即清零
_RULES_OVERRIDES: dict = {}
```

`_TRACE_STORE`（收敛轨迹）好一些，会 dump 到 JSON 文件，但也只是单文件全量覆写。
渲染层那侧的评估档案走 electron-store（`agentcorp.evaluation`），
于是同一份评测结论**存在两个不共享、不一致、都不可查询的地方**。

这带来四个具体后果，每一个都会在真实使用中被撞上：

1. **重启丢数据**。演示时重跑一遍还能接受；企业里跑了三周的准入记录没了不能接受。
2. **无法回答时间序问题**。「这个 agent 上个月和这个月比，返工率降了吗」——
   现在答不了，因为只有 latest。
3. **无法多机协作**。团队里 A 跑的评测，B 看不到。
4. **无法审计**。评审留痕的价值在于事后可复核，内存态等于没留痕。

## 2. 不做什么（先划边界）

- **不引入 PostgreSQL / Redis / 消息队列**。当前形态是本地优先的桌面应用，
  引入服务端组件会摧毁「零部署、评委笔记本上就能跑」这个最大优势。
- **不做多租户与权限系统**。那是企业版的事（见 roadmap Phase 3），
  现在做等于给一个没有用户的系统做用户体系。
- **不把渲染层的 electron-store 迁走**。它承担的是 UI 状态镜像，职责不同。

## 3. 方案：SQLite（标准库 `sqlite3`，零新增依赖）

### 3.1 存储位置

```
${AGENTCORP_DATA_DIR:-~/.agentcorp}/agentcorp.db
```

桌面端由主进程注入 `AGENTCORP_DATA_DIR=app.getPath('userData')`，
容器部署挂卷即可。**数据库文件即备份单位**，用户可以直接拷走 —— 这对
「数据不出本机」的承诺很重要：可迁移性是隐私承诺的一部分。

### 3.2 表结构

```sql
-- 一次评分卡（S1/S2/S3 同构）。评测的最小事实单元。
CREATE TABLE stage_score (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      TEXT    NOT NULL,
  stage         TEXT    NOT NULL,          -- preScreen | interview | performance
  job_type      TEXT    NOT NULL,
  objective     REAL    NOT NULL,
  subjective    REAL    NOT NULL,
  total         REAL    NOT NULL,
  verdict       TEXT    NOT NULL,
  preset_id     TEXT    NOT NULL,
  -- 来源三态：judge / mixed / degraded。查询时必须能按它过滤，
  -- 否则降级分会悄悄混进「历史趋势」这类聚合视图里。
  judge_source  TEXT,
  -- 采样元数据：让「这个分是谁在什么温度下打的」可追溯
  judge_models  TEXT,                      -- JSON 数组
  temperature   REAL,
  payload       TEXT    NOT NULL,          -- 完整 StageScore JSON（保真，便于回放）
  window        TEXT,
  created_at    TEXT    NOT NULL           -- ISO8601 UTC
);
CREATE INDEX idx_stage_agent_time ON stage_score(agent_id, created_at DESC);
CREATE INDEX idx_stage_source     ON stage_score(judge_source);

-- 机器可核验证据（沙盒执行 / 静态扫描）。独立成表，因为它是本项目
-- 最有价值的资产：将来做「准入分 vs 上线表现」的相关性验证要靠它。
CREATE TABLE verified_evidence (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_score_id INTEGER REFERENCES stage_score(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  dim            TEXT NOT NULL,            -- code_runnability | code_security
  kind           TEXT NOT NULL,            -- sandbox_exec | static_scan
  outcome        TEXT NOT NULL,            -- passed | failed | no_tests | scanned ...
  detail         TEXT NOT NULL,            -- 完整结果 JSON（逐用例 / 逐 finding）
  created_at     TEXT NOT NULL
);

-- 人工抽检（元评估 gold 来源）。当前存在渲染层 localStorage，应上收。
CREATE TABLE human_review (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL,
  judge_id    TEXT NOT NULL,
  judge_says  INTEGER NOT NULL,            -- 0/1
  gold        INTEGER NOT NULL,            -- 0/1
  confidence  REAL,
  dim         TEXT,
  created_at  TEXT NOT NULL
);

-- 上岗期真实任务回流（workEvaluationLoop 的落点）。
-- 有了它才能做「面试期承诺 vs 上岗后表现」的对照 —— 这是学术层面最有价值的数据集。
CREATE TABLE onjob_record (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  task_title    TEXT NOT NULL,
  approved      INTEGER,                   -- 人工验收是否通过（NULL=未验收）
  rework_rounds INTEGER DEFAULT 0,
  latency_ms    INTEGER,
  cost_usd      REAL,
  radar         TEXT,                      -- 本次回流评出的六维 JSON
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_onjob_agent_time ON onjob_record(agent_id, created_at DESC);

CREATE TABLE schema_meta (version INTEGER NOT NULL);
```

### 3.3 关键设计点

- **`payload` 保真存 JSON**：结构化列用于查询，payload 用于回放。
  评分规则会演进，两年后要重算历史分数时，只有保真原始数据才做得到。
- **`judge_source` 必须是列而不是埋在 payload 里**：所有聚合查询都要
  「只统计 source=judge」这个过滤条件，埋在 JSON 里等于没有。
- **只追加，不更新**（append-only）。评测记录被就地修改就失去审计价值。
  「更正」通过写一条新记录 + `supersedes_id` 实现（v2 再加）。
- **WAL 模式 + 单写者**：`PRAGMA journal_mode=WAL`，写操作全部经
  `app/store/db.py` 的单例连接，避免 FastAPI 多线程下的锁竞争。

### 3.4 迁移

`app/store/migrations.py`，用 `schema_meta.version` 做线性迁移，
启动时自动执行。**不引 alembic** —— 三张表的项目引 ORM 迁移框架是过度工程。

## 4. 报告导出

这是持久化的**真正价值出口**：职场人不会天天打开评测台，
但他要向老板解释「为什么选这个 agent」时，需要一份能贴进周报的东西。

`GET /api/report/{agent_id}?format=md|json`：

```markdown
# Agent 准入评审报告 · 代码审查员
生成时间：2026-08-18 14:30 UTC   报告 ID：rpt-8f3a...（可复核）

## 结论
准入判定：**OBSERVE（待观察）**    综合分 74.5 / 100
结论来源：MiniCPM-o 外部裁判（3 次采样，2 个模型家族，温度 0/0.5/0.5）
裁判健康度：人工认可率 82%（n=17），Krippendorff α=0.71，无显著漂移

## 机器可核验证据
| 维度 | 证据 | 来源 |
|---|---|---|
| code_runnability | 沙盒执行：4/4 用例通过（212ms） | 真实执行 |
| code_security | 静态扫描（bandit，0 处高危） | 真实扫描 |

## 逐题表现
### code_csv_merge · 合并两份 CSV 并处理脏数据
- ✅ updated_at 比较逻辑存在且正确 —— 引「按 updated_at 取较新一条」
- ❌ 无法解析时返回 None 而非抛异常 —— 未在答案中找到支撑
- ⚠️ 反注水探针命中：声称「已充分测试」但未给出具体用例

## 已知边界
- code_security 的「0 处高危」表示扫过且未发现，不代表这段代码是安全的
- 本结论验证的是稳定性，未验证预测有效性
```

导出格式先做 Markdown（可直接贴进飞书/Notion/周报），PDF 走浏览器打印样式，
不引 PDF 库。

## 5. 工作量与顺序

| 步骤 | 内容 | 估时 |
|---|---|---|
| 1 | `app/store/db.py`（连接单例 + WAL + 迁移执行） | 0.5d |
| 2 | `app/store/repository.py`（4 张表的读写，纯函数化 SQL） | 1d |
| 3 | `leaderboard.py` / `judge.py` 改为经 repository 读写，保留内存缓存 | 0.5d |
| 4 | `GET /api/agents/{id}/history` 时间序端点 + 前端趋势图 | 1d |
| 5 | 报告导出（Markdown 渲染 + 端点 + 前端下载按钮） | 1d |
| 6 | 人工抽检从 localStorage 上收到 SQLite | 0.5d |
| 7 | 测试：迁移幂等、并发写、source 过滤、报告快照测试 | 1d |

合计约 **5.5 人日**。

## 6. 验收标准

1. 服务重启后榜单与历史记录完整存在；
2. `GET /api/agents/{id}/history` 能返回按时间排序的评分序列，且能按
   `judge_source=judge` 过滤；
3. 报告导出的每一条证据都能追溯到 `verified_evidence` 表里的一行；
4. 迁移在空库、v1 库、v2 库上都幂等；
5. `MOCK=true pytest` 全绿，且不产生残留 db 文件（测试用 `:memory:` 或 tmp_path）。
