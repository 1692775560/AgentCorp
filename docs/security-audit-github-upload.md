# GitHub 上传安全审计清单 — AgentCorp

- **审计日期**：2026-07-22
- **审计人**：齐活林（Delivery Director）／ 软件开发团队
- **目标仓库**：https://github.com/EriXPsy/AgentCorp.git
- **范围**：清点可上传文件、确认 `.gitignore`、排查源码中的 API Key / Personal Key / 隐私泄露

---

## 一、总结论

| 检查项 | 结论 |
|---|---|
| 真实 API Key / Personal Key / 生产密钥 | ✅ **未发现** |
| 硬编码隐私（用户名绝对路径） | ✅ **已修复 3 处**（修复前存在，修复后 0 处） |
| `.env` 内容 | ✅ 仅 `VITE_MOCK=true` + 本地 `VITE_API_BASE`，无密钥，已 gitignore |
| 后端 `model-service/` | ✅ 全部环境变量驱动，无硬编码密钥 |
| 可上传性 | ✅ 源码、文档、Mock 数据、后端均可安全上传 |

> ⚠️ 次要加固项（**非阻塞**）：`model-service/app/serve.py` 的 `allow_origins=["*"]` 仅适合本地/演示，生产应限定前端域名。

---

## 二、密钥 / 隐私扫描明细

| 扫描项 | 方法 | 结果 |
|---|---|---|
| 高置信密钥模式（`ghp_` / `sk-` / `AIza` / `xoxb-` / `AKIA` / JWT） | ripgrep 全仓（排除 node_modules、dist） | **0 命中** |
| 赋值式密钥（`api_key` / `secret` / `password` / `private_key` = ...） | ripgrep 全仓（排除 node_modules、dist） | 仅 `node_modules` 内第三方库占位常量（`ReactPropTypesSecret` 等），**非真实密钥** |
| 硬编码用户名绝对路径 | ripgrep `陈思丞\|Users/.../WorkBuddy` | 修复前 **3 处**，修复后 **0 处** |
| `.env` 实际内容 | 人工读取 | `VITE_MOCK=true`；`VITE_API_BASE=http://localhost:8000`（无密钥） |
| `model-service` 配置 | 读取 `config.py` / `serve.py` / `model_loader.py` / `tts.py` | 全部 env 驱动；默认 `DEVICE=npu`，`MODEL_PATH=/models/MiniCPM-o-4.5`；无硬编码密钥 |
| `samples/` 候选人档案 | 读取 `profile.json` | 虚构 Mock 数据（琳达等），**无真实 PII** |

---

## 三、已修复的隐私泄露（3 处）

| 文件 | 原内容（泄露） | 修复方式 |
|---|---|---|
| `scripts/qa/gen.mjs:2` | `const ROOT = "C:/Users/陈思丞/WorkBuddy/YouAreFired/agentcorp";` | 改为 `const ROOT = process.cwd();`（从运行目录推导，跨机器可移植） |
| `scripts/qa/marketplace.qa.test.ts:19` | 注释中硬编码 Node 22 二进制绝对路径 | 改为占位符 `<path-to-node-22-bin>` |
| `scripts/qa/github-import.qa.test.ts:19` | 同上 | 同上修复 |

---

## 四、上传 vs 本地保留 — 文件清单

### ✅ 上传（纳入 Git 跟踪）

- `src/**` — 全部前端源码（components / services / hooks / store / types / utils / mock）
- `public/**`（如有）、`index.html`
- `docs/**` — 研究 / PRD / 架构文档（仅描述性提及 token，无真实凭据）
- `scripts/**` — `gen.mjs` + QA 测试（已脱敏）
- `samples/**` — 虚构 Mock 候选人
- `model-service/**` — Python 后端（env 驱动）
- `.env.example` — 配置模板（**有意保留**）
- 工程配置：`package.json` / `vite.config.ts` / `tsconfig*.json` / `tailwind.config.*` / `postcss.config.*` / `README.md` / `.gitignore`（本次新增）

### ⛔ 本地保留（已写入 `.gitignore`，不入库）

- `.env`、`.env.local`、`.env.*.local` — 可能含密钥
- `node_modules/` — 依赖
- `dist/`、`.vite/`、`*.tsbuildinfo`、`coverage/` — 构建 / 缓存产物
- `tmp/` — 临时文件
- `scripts/qa/.engine.qa.bundle.mjs`、`scripts/qa/.github-import.qa.bundle.mjs`、`scripts/qa/.marketplace.qa.bundle.mjs`、`scripts/qa/_fesrc/` — QA 构建产物
- `model-service/.pytest_cache/`、`model-service/**/__pycache__/`、`model-service/pytest-cache-files-*/` — Python 缓存
- `.DS_Store`、`Thumbs.db`、`.idea/`、`.vscode/`、`*.swp` — 编辑器 / 系统文件

---

## 五、次要安全建议（非阻塞）

1. **CORS**：`model-service/app/serve.py` 的 `allow_origins=["*"]` 仅适合演示；部署到共享环境时改为具体前端域名。
2. **GitHub Token 使用说明**：GitHub 导入功能为前端 `fetch` 直连 `api.github.com`（未鉴权 60 次/小时）。若用户填入 token，仅在会话内存中用于重试、**不持久化**——此设计安全，但建议在 README 注明「不要粘贴高权限 token」。
3. **README 说明**：建议在 README 顶部补充「本地运行 / 环境变量说明」，提醒 Fork 者复制 `.env.example` 为 `.env`。

---

## 六、后续动作建议

- 本次仅完成「清点 + 审计 + 脱敏 + 生成 `.gitignore`」，**尚未执行** `git init` / `commit` / `push`（你只要求清点）。
- 若确认无误，下一步可：
  1. `git init`
  2. 首次 `commit`（建议用 `git add` 仅添加被跟踪清单，避免误带 `.env`）
  3. 关联远程 `https://github.com/EriXPsy/AgentCorp.git`
  4. `git push -u origin main`
