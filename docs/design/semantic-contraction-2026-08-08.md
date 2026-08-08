# semantic_contraction 增量设计（走法一：向后兼容优先）

日期：2026-08-08
作者：齐活林（Delivery Director）
状态：待工程实现

> 本文档由主理人直接编写。原定由架构师成员产出，但 `software-architect`
> 类型 agent 在本环境连续三次空转（回问即退出 / `TaskListTaskList not found`
> 工具名解析错误 / 14s 空 completed、零文件落盘），通道物理不通，故设计环节
> 由主理人承接。实现与验证仍按 SOP 交由工程师与 QA。

## 1. 背景与约束

`convergence_score` 现有公式（`model-service/app/scoring/convergence.py:283`）：

```
score = 100 · (w1·CR + w2·(1−R) + w3·St)
```

未锚定兜底路径（`:290`）：

```
score = 100 · (w1·CR)      # 不归一化，故上限 = 100·w1
```

本次新增 `semantic_contraction`（简称 SC）维度：基于 unknowns 集合的缩减率
衡量语义收敛，弥补 CR 只看候选集规模、不看「未知项是否真被消解」的盲区。

### 用户拍定的最高优先级约束（走法一）

历史分数可比性 **优于** 代码简洁性。用户原话要点：走法二（直接拆
`w1 = CR 0.15 + semantic 0.25`、无 unknowns 时 SC 记 0）会让旧 trace 分数普遍
下降 —— 「同一个 agent 昨天 60 分今天 45 分，且原因无法向用户解释」。

因此：
- `unknowns` 默认空列表；空时 SC 返回 `None`，权重回落给 CR
- 旧数据分数**逐位不变**
- 245 个现有后端测试**一个都不改**（红线，QA 需实测验证而非假定）

## 2. unknowns 数据结构（全新）

全库 grep 实测确认：`unknowns` 字段**从未被定义过**（后端 scoring/routes、
前端 `src/**` 均零命中）。故本节为全新设计，而非「字段已存在、旧数据未填」。

```python
class Unknown(BaseModel):
    """单个待消解的未知项。"""
    uid: str          # 稳定 id —— 必需，见下方权衡
    text: str         # 人类可读描述
    severity: Literal["low", "mid", "high"] = "mid"  # 预留，本期不进权重
```

`TurnState` 新增：

```python
unknowns: List[Unknown] = Field(default_factory=list)
```

### 为何必须要稳定 uid

仅有 `text` 时，判断「同一 unknown 是否已消解」只能靠字符串匹配。措辞一变
（「不清楚部署环境」→「部署环境待确认」）就会误判成「旧的消了、新的来了」，
计数看似不变、实则完全错位。

本期采用**纯计数差**作为 SC 算法（简单、够用），但 uid 仍为必填字段：
- 计数差不依赖 uid，本期不用它
- 但 uid 一旦缺失，后续想升级为「集合差」就必须做数据迁移
- 现在留出来的成本是一个字段，将来补的成本是一次迁移

`severity` 同理：本期不进权重，但先占位，避免将来加权时改结构。

## 3. SC 算法

```
SC = clamp(1 − |U_K| / |U_0|, 0, 1)
```

其中 `U_0` = turn 0 的 unknowns，`U_K` = 末轮 unknowns。与 CR 的
「首尾比」结构同构（`CR = 1 − |S_K|/|S_0|`，`:229`），便于理解和维护。
`TurnState` 存每轮完整快照（非增量），首尾比在结构上可行。

### 防刷分条款（显式）

`len(U_0) == 0` 时 **一律返回 `None`，不给满分**。

否则形成漏洞：不填 unknowns 反而拿满分，诚实填写反被扣分。这与项目既有
铁律「人气不得冒充能力」同源 —— **缺失不得冒充优秀**。

### 负值语义

unknowns 增加是**真实信号**（探索中发现新未知），不是错误，不该被惩罚成
「收敛失败」。处理方式：

- 诊断字段 `unknowns_delta = |U_K| − |U_0|`，**据实记录，允许负数**，
  供前端显示「新增 N 项未知」
- 进 score 加权时 `clamp` 下界到 0，避免负分传导

## 4. 权重方案：同族按现存项重新归一化

四个权重分两族：

| 族 | 项 | 权重 |
|----|-----|------|
| 收缩族 | CR | w1 = 0.15 |
| 收缩族 | SC | w_sem = 0.25 |
| 对齐族 | 1−R | w2 = 0.35 |
| 对齐族 | St | w3 = 0.25 |

**规则**：任一项不可用时，从分母剔除其权重，其余项按剩余权重和归一化。
任何组合下满分恒为 100，各项相对重要性不变。

### 为何不选「CR 独吞」

CR 独吞（0.15+0.25=0.40 全给 CR）会让「有 unknowns」与「无 unknowns」两种
trace 中同一个 CR 值的边际贡献差 **2.67 倍**，分数无法横向解释。

### 为何不选「剩余 0.25 摊给 w2/w3」

那会把 0.25 摊到对齐族，**旧分数立刻漂移** —— 走法一的全部意义就没了。

收缩族内部回落（无 SC 时 CR 权重回落至 0.40）恰好等于旧代码的 w1=0.40，
这是旧分数逐位不变的数学保证。

## 5. 四种组合：完整公式 + 数值算例

统一输入：`CR=0.60, SC=0.80, R=0.20, St=0.70`

### 格 1 — 锚定 + 有 unknowns（四项全在，分母 1.00）

```
100 · (0.15·0.60 + 0.25·0.80 + 0.35·0.80 + 0.25·0.70)
= 100 · (0.09 + 0.20 + 0.28 + 0.175)
= 74.5
```

### 格 2 — 锚定 + 无 unknowns（剔除 w_sem，收缩族回落，分母 1.00）

```
100 · (0.40·0.60 + 0.35·0.80 + 0.25·0.70) / (0.40+0.35+0.25)
= 100 · (0.24 + 0.28 + 0.175)
= 69.5
```

**关键校验**：`0.40·CR` 与旧代码 `w1·CR`（w1=0.40）**完全一致**，
旧 trace 分数一分不变。这是走法一的核心承诺。

### 格 3 — 未锚定 + 有 unknowns（剔除 w2/w3，分母 0.40）

```
100 · (0.15·0.60 + 0.25·0.80) / 0.40
= 100 · (0.09 + 0.20) / 0.40
= 72.5
```

### 格 4 — 未锚定 + 无 unknowns（仅剩 CR，分母 0.40）

```
100 · (0.40·0.60) / 0.40 = 60.0
```

### 汇总

| 组合 | 分数 | 满分 |
|------|------|------|
| 锚定 + 有 unknowns | 74.5 | 100 |
| 锚定 + 无 unknowns | 69.5 | 100 |
| 未锚定 + 有 unknowns | 72.5 | 100 |
| 未锚定 + 无 unknowns | 60.0 | 100 |

四格无不可解释跳变，每格满分均为 100。

## 6. 顺带修复：未锚定路径不归一化（行为变更，必须公示）

旧 `:290` 未锚定路径 `100·w1·CR` 不归一化，导致未锚定分数**上限被硬压在
`100·w1` = 40 分**。新方案格 4 为 `100·CR`，上限恢复 100。

**这是一处刻意的行为变更**：未锚定 trace 分数会整体上移。旧的 40 分上限
是 bug 而非设计意图（一个 CR=1.0 的完美收缩 trace 只因缺人类背书就被判 40 分，
无法解释）。必须在 `docs/api/contracts.md` 显式写明，否则协作者聚合端会把
上移误判为回归。

> 注意：此项**不违反**「旧分数不变」承诺的适用范围 —— 该承诺针对的是
> 走法一 vs 走法二的权重拆分差异（格 2 已逐位对齐）。未锚定归一化是独立的
> bug 修复，需要单独向用户与协作者说明。若用户希望连这项一并冻结，
> 可加开关保留旧行为，但**不建议** —— 那是把 bug 固化成契约。

## 7. 契约字段（写入 docs/api/contracts.md）

`ConvergenceScore` 新增：

```python
semantic_contraction: float   # SC ∈[0,1]；未计算时填 0.0 保数值契约
semantic_scored: bool         # SC 是否真的参与评分
unknowns_delta: int           # |U_K| − |U_0|，允许负数，纯诊断
```

### None vs 0.0 的处理（照抄 A3 `anchored` 先例）

- 内部计算函数返回 `Optional[float]`，`None` 表示「没算」
- **出参时填 `0.0`**，保持数值契约（下游 `toFixed` / `Number` 不崩）
- 用 `semantic_scored: bool` 区分「没算」与「一项未知都没消解」
- UI 在 `semantic_scored=false` 时显示「—」而非 `0.000`
- **下游禁止靠 `is None` / `?? 0` 判断** —— 隐式契约会被某个 `or 0` 吃掉，
  这正是 A3 修过的同类问题

### 默认值方向准则（A2 先例推广）

新增字段的默认值必须指向「**无数据 / 最保守**」，不能指向「表现良好」。
`unknowns` 默认空列表 → SC 判 `None` 而非满分，符合此准则。

## 8. 实现任务列表（交工程师）

按顺序执行，每步可独立验证：

1. **`scoring/convergence.py`** — 新增 `Unknown` 模型；`TurnState` 加
   `unknowns` 可选字段（`default_factory=list`）
2. **`scoring/convergence.py`** — 实现 `_semantic_contraction()`，返回
   `(Optional[float], int)`（SC 值 + delta）；零分母返 `None`
3. **`scoring/convergence.py`** — 重写权重计算为「同族归一化」，覆盖四格；
   替换 `:283` 与 `:290` 两条路径为统一实现
4. **`scoring/convergence.py`** — `ConvergenceScore` 加三个新字段
5. **`routes/convergence.py`** — 出参透传新字段
6. **`src/types/convergence.ts`** — 同步类型定义
7. **`ConvergenceTrajectoryWidget.tsx`** — `semantic_scored=false` 显示「—」；
   `unknowns_delta < 0` 显示「新增 N 项未知」
8. **`docs/api/contracts.md`** — 写入第 7 节字段 + 第 6 节行为变更公示

### 验收红线

- **245 个现有后端测试一个都不改，全部通过**（实测验证，不得假定）
- 新增测试须覆盖四格 + 零分母 + 负 delta
- 格 2 的数值须与改动前旧代码输出**逐位一致**（回归对比）

### 环境铁律

- 后端测试：`model-service/.venv/Scripts/python.exe -m pytest -q`
- 前端：`env -u NODE_OPTIONS npx vitest run --pool=threads`
- 类型检查：`env -u NODE_OPTIONS npx tsc --noEmit`
- 禁止 pnpm/npm/pip install；`rm` 被拦截（删除用 `mv` 或 `git checkout --`）
