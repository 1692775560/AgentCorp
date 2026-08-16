# 自动化验证报告

生成时间：2026-08-16T00:21:28.383Z（由 `pnpm verify` 自动生成，勿手改）

| 门禁步骤 | 命令 | 结果 | 耗时 |
|---|---|---|---|
| typecheck（tsc --noEmit 双 tsconfig） | `corepack pnpm typecheck` | ✅ PASS | 19.9s |
| 多 Agent 协同专项测试（adapter/closedLoop/skills/otel/trace-sink/approval-gate/hiclaw-crd） | `corepack pnpm vitest run --pool=threads tests/unit/agentteams-adapter.test.ts tests/unit/closedLoop.test.ts tests/unit/skills-registry.test.ts tests/unit/skills-handlers.test.ts tests/unit/skills-experience.test.ts tests/unit/otel-genai.test.ts tests/unit/trace-sink.test.ts tests/unit/approval-gate.test.ts tests/unit/hiclaw-crd.test.ts` | ✅ PASS | 2.7s |
| 隐私 grep（privacy:check） | `corepack pnpm privacy:check` | ✅ PASS | 0.3s |

**总结论：✅ PASS（全部门禁通过）**

## 关键输出摘录

### typecheck（tsc --noEmit 双 tsconfig）

```
> agentcorp@0.2.3 typecheck <repo>
> tsc --noEmit && tsc --noEmit -p tsconfig.node.json
```

### 多 Agent 协同专项测试（adapter/closedLoop/skills/otel/trace-sink/approval-gate/hiclaw-crd）

```
 [32m✓[39m tests/unit/otel-genai.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 6[2mms[22m[39m

[2m Test Files [22m [1m[32m9 passed[39m[22m[90m (9)[39m
[2m      Tests [22m [1m[32m66 passed[39m[22m[90m (66)[39m
[2m   Start at [22m 00:21:25
[2m   Duration [22m 2.04s[2m (transform 371ms, setup 0ms, import 710ms, tests 101ms, environment 1ms)[22m
```

### 隐私 grep（privacy:check）

```
> agentcorp@0.2.3 privacy:check <repo>
> bash scripts/privacy-grep.sh

privacy-grep: CLEAN
```
