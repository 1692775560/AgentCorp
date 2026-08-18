# 自动化验证报告

生成时间：2026-08-16T07:27:31.692Z（由 `pnpm verify` 自动生成，勿手改）

| 门禁步骤 | 命令 | 结果 | 耗时 |
|---|---|---|---|
| typecheck（tsc --noEmit 双 tsconfig） | `corepack pnpm typecheck` | ✅ PASS | 20.8s |
| 多 Agent 协同专项测试（adapter/closedLoop/skills/otel/trace-sink/approval-gate/hiclaw-crd） | `corepack pnpm vitest run --pool=threads tests/unit/agentteams-adapter.test.ts tests/unit/closedLoop.test.ts tests/unit/skills-registry.test.ts tests/unit/skills-handlers.test.ts tests/unit/skills-experience.test.ts tests/unit/otel-genai.test.ts tests/unit/trace-sink.test.ts tests/unit/approval-gate.test.ts tests/unit/hiclaw-crd.test.ts` | ✅ PASS | 2.8s |
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
 [32m✓[39m tests/unit/skills-registry.test.ts [2m([22m[2m6 tests[22m[2m)[22m[32m 7[2mms[22m[39m

[2m Test Files [22m [1m[32m9 passed[39m[22m[90m (9)[39m
[2m      Tests [22m [1m[32m66 passed[39m[22m[90m (66)[39m
[2m   Start at [22m 07:27:29
[2m   Duration [22m 2.10s[2m (transform 392ms, setup 0ms, import 744ms, tests 100ms, environment 1ms)[22m
```

### 隐私 grep（privacy:check）

```
> agentcorp@0.2.3 privacy:check <repo>
> bash scripts/privacy-grep.sh

privacy-grep: CLEAN
```
