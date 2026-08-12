# GOAI 复赛自动化验证报告

生成时间：2026-08-12T12:31:59.625Z（由 `pnpm verify:goai` 自动生成，勿手改）

| 门禁步骤 | 命令 | 结果 | 耗时 |
|---|---|---|---|
| typecheck（tsc --noEmit 双 tsconfig） | `corepack pnpm typecheck` | ✅ PASS | 5.0s |
| GOAI 专项测试（adapter/closedLoop/skills/otel/trace-sink） | `corepack pnpm vitest run --pool=threads tests/unit/agentteams-adapter.test.ts tests/unit/closedLoop.test.ts tests/unit/skills-registry.test.ts tests/unit/skills-handlers.test.ts tests/unit/skills-experience.test.ts tests/unit/otel-genai.test.ts tests/unit/trace-sink.test.ts` | ✅ PASS | 0.6s |
| 隐私 grep（privacy:check） | `corepack pnpm privacy:check` | ✅ PASS | 0.1s |

**总结论：✅ PASS（全部门禁通过）**

## 关键输出摘录

### typecheck（tsc --noEmit 双 tsconfig）

```
> agentcorp@0.2.3 typecheck <repo>
> tsc --noEmit && tsc --noEmit -p tsconfig.node.json
```

### GOAI 专项测试（adapter/closedLoop/skills/otel/trace-sink）

```
 ✓ tests/unit/trace-sink.test.ts (4 tests) 6ms

 Test Files  7 passed (7)
      Tests  45 passed (45)
   Start at  20:31:59
   Duration  157ms (transform 408ms, setup 0ms, import 553ms, tests 33ms, environment 0ms)
```

### 隐私 grep（privacy:check）

```
> agentcorp@0.2.3 privacy:check <repo>
> bash scripts/privacy-grep.sh

privacy-grep: CLEAN
```
