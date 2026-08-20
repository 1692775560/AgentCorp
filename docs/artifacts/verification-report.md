# 自动化验证报告

生成时间：2026-08-20T03:51:52.337Z（由 `pnpm verify` 自动生成，勿手改）

| 门禁步骤 | 命令 | 结果 | 耗时 |
|---|---|---|---|
| typecheck（tsc --noEmit 双 tsconfig） | `corepack pnpm typecheck` | ✅ PASS | 6.1s |
| 多 Agent 协同专项测试（adapter/closedLoop/skills/otel/trace-sink/approval-gate/hiclaw-crd） | `corepack pnpm vitest run --pool=threads tests/unit/agentteams-adapter.test.ts tests/unit/closedLoop.test.ts tests/unit/skills-registry.test.ts tests/unit/skills-handlers.test.ts tests/unit/skills-experience.test.ts tests/unit/otel-genai.test.ts tests/unit/trace-sink.test.ts tests/unit/approval-gate.test.ts tests/unit/hiclaw-crd.test.ts` | ✅ PASS | 0.7s |
| 隐私 grep（privacy:check） | `corepack pnpm privacy:check` | ✅ PASS | 0.2s |

**总结论：✅ PASS（全部门禁通过）**

## 关键输出摘录

### typecheck（tsc --noEmit 双 tsconfig）

```
> agentcorp@0.2.3 typecheck <repo>
> tsc --noEmit && tsc --noEmit -p tsconfig.node.json
```

### 多 Agent 协同专项测试（adapter/closedLoop/skills/otel/trace-sink/approval-gate/hiclaw-crd）

```
 ✓ tests/unit/trace-sink.test.ts (4 tests) 6ms

 Test Files  9 passed (9)
      Tests  66 passed (66)
   Start at  11:51:51
   Duration  205ms (transform 667ms, setup 0ms, import 912ms, tests 43ms, environment 1ms)
```

### 隐私 grep（privacy:check）

```
> agentcorp@0.2.3 privacy:check <repo>
> bash scripts/privacy-grep.sh

privacy-grep: CLEAN
```
