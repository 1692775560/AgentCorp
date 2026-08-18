/**
 * 多 Agent 协同编排器单测：mock ChatFn（确定性脚本化回复），
 * 覆盖分解/指派/开工确认/并行执行/审阅返工/失败改派/交叉评审/重规划/汇总
 * 全链路与各兜底分支。
 */
import { describe, it, expect } from "vitest";
import {
  runSquadOrchestration,
  parseSubTasks,
  classifySubTaskKind,
  type OrchestrationInput,
} from "../../src/engine/squad/squadOrchestration";
import type { ChatFn, ChatMessage } from "../../src/engine/squad/squadCollaboration";
import type { Team } from "../../src/types/team";
import type { RoutingCandidate } from "../../src/engine/squad/squadRouting";

const team: Team = {
  id: "team-1",
  name: "测试团队",
  leaderId: "leader",
  memberIds: ["m1", "m2"],
  description: "",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
};

function candidates(): RoutingCandidate[] {
  return [
    { agentId: "leader", active: true, userFit: 50 },
    { agentId: "m1", active: true, userFit: 90, radar: { task: 5, quality: 5, comm: 5, creativity: 5, reliability: 5, cost: 5 } },
    { agentId: "m2", active: true, userFit: 80, radar: { task: 4, quality: 4, comm: 4, creativity: 4, reliability: 4, cost: 4 } },
  ];
}

/** 脚本化 chat：按 system 内容识别调用环节，返回配置好的回复。 */
function scriptedChat(script: {
  decompose?: string;
  execute?: (agentId: string, msgs: ChatMessage[], callIndex: number) => string;
  review?: (callIndex: number) => string;
  summarize?: string;
  /** 开工确认：成员提问（默认 "OK" = 无疑问）。 */
  kickoff?: (agentId: string) => string;
  /** 开工确认：leader 批量解答文本。 */
  kickoffAnswer?: string;
  /** 交叉评审：成员回复（默认 "OK" = 无需修订）。 */
  crossReview?: (agentId: string) => string;
  /** 重规划：leader 回复（默认 "OK" = 不追加）。 */
  replan?: string;
  /** 盲审：第三方成员复核（默认 "PASS"）。 */
  blindReview?: (agentId: string, callIndex: number) => string;
  /** 高质量模式：leader 合成两版草案（默认 "合成版产出"）。 */
  synthesize?: string;
  calls?: { agentId: string; msgs: ChatMessage[] }[];
}): ChatFn {
  let execIdx = 0;
  let reviewIdx = 0;
  let blindIdx = 0;
  return async (agentId, msgs) => {
    script.calls?.push({ agentId, msgs });
    const sys = msgs[0]?.content ?? "";
    // 新步骤标记词先行判定（与 拆解/汇总/审阅 互不冲突）
    if (sys.includes("批量解答")) return script.kickoffAnswer ?? "已解答。";
    if (sys.includes("开工确认")) return script.kickoff ? script.kickoff(agentId) : "OK";
    if (sys.includes("交叉评审")) return script.crossReview ? script.crossReview(agentId) : "OK";
    if (sys.includes("重规划")) return script.replan ?? "OK";
    // 拆解/汇总须先于盲审/合成判定：拆解 prompt 提到「盲审」，合成 prompt 提到「审阅意见」
    if (sys.includes("拆解")) return script.decompose ?? "[]";
    if (sys.includes("汇总")) return script.summarize ?? "汇总交付物";
    if (sys.includes("盲审")) {
      blindIdx += 1;
      return script.blindReview ? script.blindReview(agentId, blindIdx) : "PASS";
    }
    if (sys.includes("合成")) return script.synthesize ?? "合成版产出";
    if (sys.includes("审阅")) {
      reviewIdx += 1;
      return script.review ? script.review(reviewIdx) : "PASS";
    }
    // 其余视为成员执行
    execIdx += 1;
    if (script.execute) return script.execute(agentId, msgs, execIdx);
    return `${agentId} 的产出`;
  };
}

function baseInput(overrides: Partial<OrchestrationInput> = {}): OrchestrationInput {
  return {
    taskId: "task-1",
    taskTitle: "做一份市场调研",
    taskDescription: "调研竞品并输出报告",
    team,
    candidates: candidates(),
    chat: scriptedChat({}),
    ...overrides,
  };
}

describe("parseSubTasks 容错解析", () => {
  it("解析 ```json 包裹的数组", () => {
    const raw = '好的，拆解如下：\n```json\n[{"title":"a","instruction":"b"}]\n```';
    expect(parseSubTasks(raw)).toEqual([{ title: "a", instruction: "b" }]);
  });

  it("解析带解释文字的裸数组", () => {
    const raw = '拆解结果：[{"title":"a","instruction":"b","assigneeId":"m1"}] 以上。';
    expect(parseSubTasks(raw)).toEqual([{ title: "a", instruction: "b", assigneeId: "m1" }]);
  });

  it("非法 JSON / 空数组 / 缺字段 → null", () => {
    expect(parseSubTasks("这不是 JSON")).toBeNull();
    expect(parseSubTasks("[]")).toBeNull();
    expect(parseSubTasks('[{"title":"a"}]')).toBeNull();
  });
});

describe("classifySubTaskKind 工种分级", () => {
  it("代码类关键词命中 → code", () => {
    expect(classifySubTaskKind("实现登录页面", "用 HTML+CSS 开发")).toBe("code");
    expect(classifySubTaskKind("写一个脚本", "调用下游接口")).toBe("code");
  });

  it("长文类关键词命中 → long", () => {
    expect(classifySubTaskKind("竞品分析报告", "调研并输出方案")).toBe("long");
    expect(classifySubTaskKind("活动文案", "设计传播文案")).toBe("long");
  });

  it("无关键词 → short（默认）", () => {
    expect(classifySubTaskKind("订会议室", "确认时间与人数")).toBe("short");
  });

  it("同时命中时代码类优先", () => {
    expect(classifySubTaskKind("开发数据报告页面", "实现一个网页报告")).toBe("code");
  });
});

describe("runSquadOrchestration", () => {
  it("审阅判定回归：「REWORK：尚未 PASS」不得误判通过；「PASS，可以合并」正常通过", async () => {
    const chat = scriptedChat({
      decompose: JSON.stringify([
        { title: "调研 A", instruction: "调研竞品 A", assigneeId: "m1" },
      ]),
      review: (i) =>
        // 第一轮 leader 回「REWORK：尚未 PASS」（旧 includes('PASS') 会误判通过）；
        // 第二轮回带尾随标点的 PASS 变体。
        i === 1 ? "REWORK：尚未 PASS，数据缺口还在" : "PASS，可以合并。",
    });
    const result = await runSquadOrchestration(baseInput({ chat, maxRounds: 2 }));

    // 被正确打回并重做到第二轮才通过
    expect(result.subtasks[0].rounds).toBe(2);
    expect(result.subtasks[0].approved).toBe(true);
    expect(result.subtasks[0].verdict).toContain("PASS，可以合并");
  });

  it("审阅首行既非 PASS 也非 REWORK → 保守视为不通过", async () => {
    const chat = scriptedChat({
      decompose: JSON.stringify([{ title: "调研", instruction: "调研竞品", assigneeId: "m1" }]),
      review: () => "我觉得还差一点火候",
    });
    const result = await runSquadOrchestration(baseInput({ chat, maxRounds: 2 }));
    expect(result.subtasks[0].approved).toBe(false);
    expect(result.subtasks[0].rounds).toBe(2);
  });

  it("开工确认 OK 归一化：「OK，没问题。」不再被当成提问", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: JSON.stringify([
        { title: "调研 A", instruction: "调研竞品 A", assigneeId: "m1" },
        { title: "调研 B", instruction: "调研竞品 B", assigneeId: "m2" },
      ]),
      kickoff: (agentId) => (agentId === "m1" ? "OK，没问题。" : "ok"),
      calls,
    });
    const result = await runSquadOrchestration(baseInput({ chat }));

    // 两个成员的确认变体都算 OK：不发起 leader 批量解答、不落开工确认 trace
    expect(calls.some((c) => c.msgs[0]?.content.includes("批量解答"))).toBe(false);
    expect(result.traces.some((t) => t.summary.includes("开工确认"))).toBe(false);
  });

  it("交叉评审：「OK，无需调整。」不覆盖产出；过短的修订版（防一句话覆盖）不替换", async () => {
    const longOutput = `m1 的完整产出。${"数据与分析细节。".repeat(60)}`; // >200 字
    const chat = scriptedChat({
      decompose: JSON.stringify([
        { title: "调研 A", instruction: "调研竞品 A", assigneeId: "m1" },
        { title: "调研 B", instruction: "调研竞品 B", assigneeId: "m2" },
      ]),
      execute: (agentId) => (agentId === "m1" ? longOutput : `${agentId} 的产出`),
      crossReview: (agentId) =>
        agentId === "m2" ? "OK，无需调整。" : "短回复：我统一了口径。", // 20 字，远低于原产出的 50%
    });
    const result = await runSquadOrchestration(baseInput({ chat }));

    expect(result.subtasks[1].output).toBe("m2 的产出"); // OK 变体不覆盖
    expect(result.subtasks[0].output).toBe(longOutput); // 过短修订版不覆盖
    expect(result.traces.some((t) => t.summary.includes("交叉评审后修订产出"))).toBe(false);
  });

  it("正常链路：分解 2 子任务 → 并行执行 → 全 PASS → 汇总", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: JSON.stringify([
        { title: "调研 A", instruction: "调研竞品 A", assigneeId: "m1" },
        { title: "调研 B", instruction: "调研竞品 B", assigneeId: "m2" },
      ]),
      calls,
    });
    const result = await runSquadOrchestration(baseInput({ chat }));

    expect(result.subtasks).toHaveLength(2);
    expect(result.subtasks.every((s) => s.approved)).toBe(true);
    expect(result.subtasks.map((s) => s.assigneeId)).toEqual(["m1", "m2"]);
    expect(result.subtasks.every((s) => s.assignedBy === "decompose")).toBe(true);
    expect(result.deliverable).toBe("汇总交付物");
    // 两个成员都真实执行过
    expect(calls.some((c) => c.agentId === "m1")).toBe(true);
    expect(calls.some((c) => c.agentId === "m2")).toBe(true);
    // trace：拆解 1 + 指派 2 + 执行 2 + 审阅 2 + 汇总 1
    // （新步骤全部默认 OK：开工确认无疑问、交叉评审不修订、重规划不追加，均不落 trace）
    expect(result.traces).toHaveLength(8);
    expect(result.traces.some((t) => t.summary.includes("拆解任务为 2"))).toBe(true);
    expect(result.traces.filter((t) => t.state === "completed")).toHaveLength(3); // 2 审阅 PASS + 汇总
    expect(result.traces.some((t) => t.summary.includes("开工确认"))).toBe(false);
    expect(result.traces.some((t) => t.summary.includes("交叉评审"))).toBe(false);
    expect(result.traces.some((t) => t.summary.includes("重规划"))).toBe(false);
  });

  it("分解 JSON 解析失败 → 兜底单子任务（原任务）并路由指派", async () => {
    const chat = scriptedChat({ decompose: "我想了想，还是不拆了。" });
    const result = await runSquadOrchestration(baseInput({ chat }));

    expect(result.subtasks).toHaveLength(1);
    expect(result.subtasks[0].title).toBe("做一份市场调研");
    // 兜底子任务无 assigneeId → 路由兜底选中最优在职成员 m1
    expect(result.subtasks[0].assignedBy).toBe("routing");
    expect(result.subtasks[0].assigneeId).toBe("m1");
    expect(result.subtasks[0].approved).toBe(true);
  });

  it("assigneeId 非法（非团队成员）→ routeBySquadLeader 兜底", async () => {
    const chat = scriptedChat({
      decompose: JSON.stringify([{ title: "调研", instruction: "调研竞品", assigneeId: "ghost" }]),
    });
    const result = await runSquadOrchestration(baseInput({ chat }));

    expect(result.subtasks[0].assignedBy).toBe("routing");
    expect(result.subtasks[0].assigneeId).toBe("m1");
    expect(team.memberIds.concat(team.leaderId)).toContain(result.subtasks[0].assigneeId);
  });

  it("REWORK 一轮后 PASS：成员收到返工意见并重做", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: JSON.stringify([{ title: "调研", instruction: "调研竞品", assigneeId: "m1" }]),
      review: (i) => (i === 1 ? "REWORK\n数据太旧，请更新" : "PASS\n可以了"),
      calls,
    });
    const result = await runSquadOrchestration(baseInput({ chat, maxRounds: 2 }));

    expect(result.subtasks[0].rounds).toBe(2);
    expect(result.subtasks[0].approved).toBe(true);
    // 第二轮执行消息里带了返工意见
    const execCalls = calls.filter(
      (c) => c.agentId === "m1" && !c.msgs[0]?.content.includes("开工确认"),
    );
    expect(execCalls).toHaveLength(2);
    expect(execCalls[1].msgs.some((m) => m.content.includes("数据太旧"))).toBe(true);
    // 审阅 trace：先 input-required 后 completed
    const reviews = result.traces.filter((t) => t.summary.includes("审阅"));
    expect(reviews[0].state).toBe("input-required");
    expect(reviews[1].state).toBe("completed");
  });

  it("持续 REWORK 达 maxRounds → 强制收尾，approved=false", async () => {
    const chat = scriptedChat({
      decompose: JSON.stringify([{ title: "调研", instruction: "调研竞品", assigneeId: "m1" }]),
      review: () => "REWORK\n还不行",
    });
    const result = await runSquadOrchestration(baseInput({ chat, maxRounds: 2 }));

    expect(result.subtasks[0].rounds).toBe(2);
    expect(result.subtasks[0].approved).toBe(false);
    expect(result.subtasks[0].output).toBeTruthy(); // 最后产出仍保留进汇总
    expect(result.deliverable).toBe("汇总交付物"); // 汇总照常进行
  });

  it("成员执行失败 → 自动改派其他成员重试成功，不阻塞全局", async () => {
    const chat = scriptedChat({
      decompose: JSON.stringify([
        { title: "调研 A", instruction: "调研竞品 A", assigneeId: "m1" },
        { title: "调研 B", instruction: "调研竞品 B", assigneeId: "m2" },
      ]),
      execute: (agentId) => {
        if (agentId === "m1") throw new Error("LLM 超时");
        return `${agentId} 的产出`;
      },
    });
    const result = await runSquadOrchestration(baseInput({ chat }));

    const [s1, s2] = result.subtasks;
    // m1 失败 → 改派 m2 重试成功
    expect(s1.assigneeId).toBe("m2");
    expect(s1.assignedBy).toBe("routing");
    expect(s1.error).toBeUndefined();
    expect(s1.approved).toBe(true);
    expect(s2.approved).toBe(true);
    // 改派 trace 落「working」，且整个流程无 failed 终态
    expect(result.traces.some((t) => t.summary.includes("改派给 m2 重试"))).toBe(true);
    expect(result.traces.some((t) => t.state === "failed")).toBe(false);
    expect(result.deliverable).toBe("汇总交付物");
  });

  it("改派也失败 → 维持 error 终态，trace 落 failed", async () => {
    const chat = scriptedChat({
      decompose: JSON.stringify([{ title: "调研", instruction: "调研竞品", assigneeId: "m1" }]),
      execute: () => {
        throw new Error("LLM 超时");
      },
    });
    const result = await runSquadOrchestration(baseInput({ chat }));

    const s1 = result.subtasks[0];
    // m1 失败 → 改派 m2 → m2 也失败 → error 终态
    expect(s1.assigneeId).toBe("m2");
    expect(s1.assignedBy).toBe("routing");
    expect(s1.error).toContain("LLM 超时");
    expect(s1.output).toBeNull();
    expect(s1.approved).toBe(false);
    expect(result.traces.some((t) => t.summary.includes("改派"))).toBe(true);
    expect(result.traces.some((t) => t.state === "failed")).toBe(true);
    expect(result.deliverable).toBe("汇总交付物"); // 汇总照常进行
  });

  it("开工确认：成员提问 → leader 批量解答一次 → 解答注入该成员执行消息", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: JSON.stringify([
        { title: "调研 A", instruction: "调研竞品 A", assigneeId: "m1" },
        { title: "调研 B", instruction: "调研竞品 B", assigneeId: "m2" },
      ]),
      kickoff: (agentId) => (agentId === "m1" ? "两部分的接口格式怎么对齐？" : "OK"),
      kickoffAnswer: "1. 接口格式统一用 REST JSON。",
      calls,
    });
    const result = await runSquadOrchestration(baseInput({ chat }));

    // leader 批量解答只调用一次
    const answerCalls = calls.filter((c) => c.msgs[0]?.content.includes("批量解答"));
    expect(answerCalls).toHaveLength(1);
    expect(answerCalls[0].agentId).toBe("leader");
    // 解答文本出现在提问成员 m1 的执行 messages 里
    const m1Exec = calls.find(
      (c) => c.agentId === "m1" && c.msgs.some((m) => m.content.includes("REST JSON")),
    );
    expect(m1Exec).toBeTruthy();
    // m2 无疑问，其执行消息不含解答
    const m2Exec = calls.find(
      (c) => c.agentId === "m2" && !c.msgs[0]?.content.includes("开工确认") && !c.msgs[0]?.content.includes("交叉评审"),
    );
    expect(m2Exec?.msgs.some((m) => m.content.includes("REST JSON"))).toBe(false);
    // trace 落开工确认
    expect(result.traces.some((t) => t.summary.includes("开工确认：成员提出 1 个问题"))).toBe(true);
  });

  it("交叉评审：成员返回修订版 → 产出被替换；返回 OK → 不变", async () => {
    const chat = scriptedChat({
      decompose: JSON.stringify([
        { title: "调研 A", instruction: "调研竞品 A", assigneeId: "m1" },
        { title: "调研 B", instruction: "调研竞品 B", assigneeId: "m2" },
      ]),
      crossReview: (agentId) =>
        agentId === "m1"
          ? "修订版：结合 B 的产出统一了数据口径与引用格式，这是完整修订版本。"
          : "OK",
    });
    const result = await runSquadOrchestration(baseInput({ chat }));

    expect(result.subtasks[0].output).toContain("修订版");
    expect(result.subtasks[1].output).toBe("m2 的产出"); // OK → 不替换
    expect(result.traces.some((t) => t.summary.includes("交叉评审后修订产出"))).toBe(true);
  });

  it("重规划：leader 返回追加子任务 JSON → 子任务多一条且被执行", async () => {
    const chat = scriptedChat({
      decompose: JSON.stringify([{ title: "调研 A", instruction: "调研竞品 A", assigneeId: "m1" }]),
      replan: JSON.stringify([{ title: "补充调研 C", instruction: "调研竞品 C", assigneeId: "m2" }]),
    });
    const result = await runSquadOrchestration(baseInput({ chat }));

    expect(result.subtasks).toHaveLength(2);
    expect(result.subtasks[1].title).toBe("补充调研 C");
    expect(result.subtasks[1].assigneeId).toBe("m2");
    expect(result.subtasks[1].output).toBe("m2 的产出"); // 追加的子任务真实执行过
    expect(result.subtasks[1].approved).toBe(true);
    expect(result.traces.some((t) => t.summary.includes("重规划：追加 1 个子任务"))).toBe(true);
  });

  it("persona 注入：有 persona 的成员 system 消息含人格文本", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: JSON.stringify([{ title: "调研", instruction: "调研竞品", assigneeId: "m1" }]),
      calls,
    });
    await runSquadOrchestration(
      baseInput({ chat, personas: { m1: "你是一位严谨的分析师。" } }),
    );
    const execCall = calls.find(
      (c) => c.agentId === "m1" && !c.msgs[0]?.content.includes("开工确认"),
    );
    expect(execCall?.msgs[0].content).toContain("严谨的分析师");
  });

  it("审阅标准：prompt 含「意见解决即 PASS」约束，第 2 轮带上轮意见核对", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: JSON.stringify([{ title: "调研", instruction: "调研竞品", assigneeId: "m1" }]),
      review: (i) => (i === 1 ? "REWORK\n补充数据来源" : "PASS\n已补充"),
      calls,
    });
    const result = await runSquadOrchestration(baseInput({ chat, maxRounds: 2 }));

    expect(result.subtasks[0].approved).toBe(true);
    const reviewCalls = calls.filter((c) => c.msgs[0]?.content.includes("审阅成员"));
    expect(reviewCalls.length).toBe(2);
    // 审阅标准约束：意见被解决应 PASS、禁止要求无法完成的外部核验
    expect(reviewCalls[0].msgs[0].content).toContain("逐条解决");
    expect(reviewCalls[0].msgs[0].content).toContain("外部核验");
    // 第 2 轮 user 消息带上轮意见供核对
    expect(reviewCalls[1].msgs.at(-1)?.content).toContain("上一轮审阅意见");
    expect(reviewCalls[1].msgs.at(-1)?.content).toContain("补充数据来源");
  });

  it("汇总上限动态化：随子任务数增大，prompt 明确告知上限且不压内容", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: JSON.stringify([
        { title: "A", instruction: "做 A", assigneeId: "m1" },
        { title: "B", instruction: "做 B", assigneeId: "m2" },
        { title: "C", instruction: "做 C", assigneeId: "m1" },
      ]),
      calls,
    });
    await runSquadOrchestration(baseInput({ chat }));

    const summarizeCall = calls.find((c) => c.msgs[0]?.content.includes("汇总"));
    // 3 个子任务 → 6000 + 3×2000 = 12000
    expect(summarizeCall?.msgs[0].content).toContain("12000");
    expect(summarizeCall?.msgs[0].content).toContain("不要为压缩篇幅砍掉实质内容");
  });

  it("拆解约束：prompt 禁止 leader 在指令里限制产出字数", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({ calls });
    await runSquadOrchestration(baseInput({ chat }));

    const decomposeCall = calls.find((c) => c.msgs[0]?.content.includes("拆解"));
    expect(decomposeCall?.msgs[0].content).toContain("不要在 instruction 里限制成员的产出字数");
  });
});


describe("parseSubTasks acceptance / requiredSections 容错", () => {
  it("合法 acceptance 与 requiredSections 被解析", () => {
    const raw = JSON.stringify([
      {
        title: "a",
        instruction: "b",
        acceptance: ["覆盖竞品", "有数据支撑"],
        requiredSections: ["数据", "结论"],
      },
    ]);
    expect(parseSubTasks(raw)).toEqual([
      {
        title: "a",
        instruction: "b",
        acceptance: ["覆盖竞品", "有数据支撑"],
        requiredSections: ["数据", "结论"],
      },
    ]);
  });

  it("缺失字段 → 子任务无 checklist（字段缺省，行为同现状）", () => {
    const parsed = parseSubTasks('[{"title":"a","instruction":"b"}]');
    expect(parsed).toEqual([{ title: "a", instruction: "b" }]);
    expect(parsed?.[0].acceptance).toBeUndefined();
    expect(parsed?.[0].requiredSections).toBeUndefined();
  });

  it("非法字段（非数组 / 条数不足 / 非字符串）→ 只丢该字段，不整体失败", () => {
    const raw = JSON.stringify([
      { title: "a", instruction: "b", acceptance: "不是数组" },
      { title: "c", instruction: "d", acceptance: ["只有一条"] }, // 不足 2 条
      { title: "e", instruction: "f", acceptance: [1, 2, 3], requiredSections: [] },
      { title: "g", instruction: "h", acceptance: ["x", "y", "z", "w", "v", "u"] }, // 6 条截断到 5
    ]);
    const parsed = parseSubTasks(raw);
    expect(parsed).toHaveLength(4);
    expect(parsed?.[0].acceptance).toBeUndefined();
    expect(parsed?.[1].acceptance).toBeUndefined();
    expect(parsed?.[2].acceptance).toBeUndefined();
    expect(parsed?.[2].requiredSections).toBeUndefined();
    expect(parsed?.[3].acceptance).toEqual(["x", "y", "z", "w", "v"]);
  });
});

describe("机检（requiredSections 结构化交付契约）", () => {
  it("缺必备部分 → 不消耗 LLM 审阅，直接 REWORK", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: JSON.stringify([
        {
          title: "写报告",
          instruction: "输出调研报告",
          assigneeId: "m1",
          requiredSections: ["数据", "结论"],
        },
      ]),
      execute: () => "只有数据，没有别的。",
      calls,
    });
    const result = await runSquadOrchestration(baseInput({ chat, maxRounds: 2 }));

    // 从未发起 leader 审阅
    expect(calls.filter((c) => c.msgs[0]?.content.includes("审阅成员"))).toHaveLength(0);
    expect(result.subtasks[0].approved).toBe(false);
    expect(result.subtasks[0].rounds).toBe(2); // 机检 REWORK 算一轮返工
    expect(result.subtasks[0].verdict).toContain("机检未过：缺少必备部分 结论");
    expect(result.traces.some((t) => t.summary.includes("机检未过"))).toBe(true);
  });

  it("机检全过 → 正常进入 leader 审阅", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: JSON.stringify([
        {
          title: "写报告",
          instruction: "输出调研报告",
          assigneeId: "m1",
          requiredSections: ["数据", "结论"],
        },
      ]),
      execute: () => "数据：xxx。结论：yyy。",
      calls,
    });
    const result = await runSquadOrchestration(baseInput({ chat }));

    expect(calls.filter((c) => c.msgs[0]?.content.includes("审阅成员"))).toHaveLength(1);
    expect(result.subtasks[0].approved).toBe(true);
    expect(result.traces.some((t) => t.summary.includes("机检"))).toBe(false);
  });
});

describe("独立盲审（acceptance checklist + 第三成员复核）", () => {
  const decomposeWithAcceptance = JSON.stringify([
    {
      title: "调研",
      instruction: "调研竞品",
      assigneeId: "m1",
      acceptance: ["覆盖竞品", "有数据支撑"],
    },
  ]);

  it("盲审 PASS → 子任务真通过，blindReview 记录评审人与意见", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: decomposeWithAcceptance,
      blindReview: () => "PASS\n两条标准均满足。",
      calls,
    });
    const result = await runSquadOrchestration(baseInput({ chat }));

    const st = result.subtasks[0];
    expect(st.approved).toBe(true);
    expect(st.blindReview).toEqual({
      reviewer: "m2", // 既非 assignee(m1) 也非 leader
      approved: true,
      notes: "PASS\n两条标准均满足。",
    });
    expect(result.traces.some((t) => t.summary.includes("盲审（m2）：PASS"))).toBe(true);
  });

  it("REVIEW prompt 逐条列出 acceptance 验收标准", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({ decompose: decomposeWithAcceptance, calls });
    await runSquadOrchestration(baseInput({ chat }));

    const reviewCall = calls.find((c) => c.msgs[0]?.content.includes("审阅成员"));
    const userMsg = reviewCall?.msgs.at(-1)?.content ?? "";
    expect(userMsg).toContain("验收标准（请逐条核对）");
    expect(userMsg).toContain("覆盖竞品");
    expect(userMsg).toContain("有数据支撑");
    // 首行契约不变的约束写进了 system
    expect(reviewCall?.msgs[0].content).toContain("第一行契约不变");
  });

  it("盲审 REWORK → 转回未通过继续返工；每子任务最多盲审 1 次", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: decomposeWithAcceptance,
      review: () => "PASS\n可以了",
      blindReview: () => "REWORK\n第 2 条验收标准未满足",
      calls,
    });
    const result = await runSquadOrchestration(baseInput({ chat, maxRounds: 3 }));

    const st = result.subtasks[0];
    // 第 1 轮 leader PASS 但盲审 REWORK → 返工；第 2 轮 leader PASS（盲审已用尽）→ 通过
    expect(st.rounds).toBe(2);
    expect(st.approved).toBe(true);
    expect(st.blindReview?.approved).toBe(false);
    expect(st.blindReview?.notes).toContain("第 2 条验收标准未满足");
    // 盲审只发生过一次
    expect(calls.filter((c) => c.msgs[0]?.content.includes("盲审："))).toHaveLength(1);
    expect(result.traces.some((t) => t.summary.includes("盲审（m2）：REWORK"))).toBe(true);
  });

  it("盲审 REWORK 且轮次耗尽 → 维持不通过并如实标注盲审意见", async () => {
    const chat = scriptedChat({
      decompose: decomposeWithAcceptance,
      review: () => "PASS\n可以了",
      blindReview: () => "REWORK\n第 1 条未满足",
    });
    const result = await runSquadOrchestration(baseInput({ chat, maxRounds: 1 }));

    const st = result.subtasks[0];
    expect(st.rounds).toBe(1);
    expect(st.approved).toBe(false);
    expect(st.verdict).toContain("盲审未过（m2）");
    expect(st.blindReview?.approved).toBe(false);
  });

  it("无第三成员（leader + 单成员）→ 跳过盲审", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({ decompose: decomposeWithAcceptance, calls });
    const result = await runSquadOrchestration(
      baseInput({
        chat,
        team: { ...team, memberIds: ["m1"] },
        candidates: candidates().filter((c) => c.agentId !== "m2"),
      }),
    );

    expect(calls.filter((c) => c.msgs[0]?.content.includes("盲审："))).toHaveLength(0);
    expect(result.subtasks[0].approved).toBe(true); // leader PASS 即通过
    expect(result.subtasks[0].blindReview).toBeUndefined();
  });

  it("无 acceptance checklist → 不触发盲审（旧行为不变）", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: JSON.stringify([{ title: "调研", instruction: "调研竞品", assigneeId: "m1" }]),
      calls,
    });
    const result = await runSquadOrchestration(baseInput({ chat }));

    expect(calls.filter((c) => c.msgs[0]?.content.includes("盲审："))).toHaveLength(0);
    expect(result.subtasks[0].approved).toBe(true);
    expect(result.subtasks[0].blindReview).toBeUndefined();
  });
});

describe("qualityMode 双草案 + 合成（MoA）", () => {
  it("两名成员各产一版草案 → leader 合成 → drafts 记录来源，合成版走正常审阅", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: JSON.stringify([{ title: "调研", instruction: "调研竞品", assigneeId: "m1" }]),
      synthesize: "合成后的最终版",
      calls,
    });
    const result = await runSquadOrchestration(baseInput({ chat, qualityMode: true }));

    const st = result.subtasks[0];
    // 两成员（主 assignee m1 + 路由选出的 m2）各自被调用产出草案
    expect(st.drafts?.map((d) => d.assigneeId)).toEqual(["m1", "m2"]);
    expect(st.drafts?.[0].output).toBe("m1 的产出");
    expect(st.drafts?.[1].output).toBe("m2 的产出");
    // 合成被调用一次，合成版作为最终产出
    expect(calls.filter((c) => c.msgs[0]?.content.includes("合成"))).toHaveLength(1);
    expect(st.output).toBe("合成后的最终版");
    expect(st.approved).toBe(true);
    // 审阅两次：草案审阅（合并指令）+ 合成版正式审阅（排除提到「审阅」的拆解/合成 prompt）
    const reviewCalls = calls.filter((c) => {
      const s = c.msgs[0]?.content ?? "";
      return s.includes("审阅成员") || s.includes("审阅子任务");
    });
    expect(reviewCalls).toHaveLength(2);
  });

  it("无第二草案成员 → 退回单草案（不调用合成）", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: JSON.stringify([{ title: "调研", instruction: "调研竞品", assigneeId: "m1" }]),
      calls,
    });
    const result = await runSquadOrchestration(
      baseInput({
        chat,
        qualityMode: true,
        team: { ...team, memberIds: ["m1"] },
        candidates: candidates().filter((c) => c.agentId !== "m2"),
      }),
    );

    const st = result.subtasks[0];
    expect(st.drafts).toBeUndefined();
    expect(calls.filter((c) => c.msgs[0]?.content.includes("合成"))).toHaveLength(0);
    expect(st.output).toBe("m1 的产出");
    expect(st.approved).toBe(true);
  });
});

describe("调用预算护栏", () => {
  it("callBudget=3 → 审阅/重规划等可选步骤跳过，汇总保底并标注「预算受限」", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({
      decompose: JSON.stringify([{ title: "调研", instruction: "调研竞品", assigneeId: "m1" }]),
      calls,
    });
    const result = await runSquadOrchestration(baseInput({ chat, callBudget: 3 }));

    // decompose(1) + 开工提问(2) + execute(3) → 预算尽；审阅/重规划跳过；summarize 保底(4)
    expect(result.llmCalls).toBe(4);
    expect(result.llmCalls).toBeLessThanOrEqual(3 + 1);
    expect(calls.filter((c) => c.msgs[0]?.content.includes("审阅成员"))).toHaveLength(0);
    expect(calls.some((c) => c.msgs[0]?.content.includes("重规划"))).toBe(false);
    expect(calls.some((c) => c.msgs[0]?.content.includes("批量解答"))).toBe(false);
    // 当前产出作为最终版保留，如实标注未通过
    expect(result.subtasks[0].output).toBe("m1 的产出");
    expect(result.subtasks[0].approved).toBe(false);
    expect(result.deliverable).toContain("预算受限，提前收敛");
    expect(result.traces.some((t) => t.summary.includes("预算护栏触发"))).toBe(true);
  });

  it("预算充足 → 不触发护栏，交付无标注（旧行为不变）", async () => {
    const chat = scriptedChat({
      decompose: JSON.stringify([{ title: "调研", instruction: "调研竞品", assigneeId: "m1" }]),
    });
    const result = await runSquadOrchestration(baseInput({ chat }));

    expect(result.deliverable).toBe("汇总交付物");
    expect(result.deliverable).not.toContain("预算受限");
    expect(result.traces.some((t) => t.summary.includes("预算护栏触发"))).toBe(false);
    expect(result.llmCalls).toBeGreaterThan(0);
  });
});

describe("experience 团队经验卡", () => {
  it("有 experience → 拼进 DECOMPOSE system（「团队既往经验」）", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({ calls });
    await runSquadOrchestration(
      baseInput({ chat, experience: "上次竞品调研漏了定价维度。" }),
    );

    const decomposeCall = calls.find((c) => c.msgs[0]?.content.includes("拆解"));
    expect(decomposeCall?.msgs[0].content).toContain("团队既往经验");
    expect(decomposeCall?.msgs[0].content).toContain("定价维度");
  });

  it("无 experience → DECOMPOSE system 不提经验", async () => {
    const calls: { agentId: string; msgs: ChatMessage[] }[] = [];
    const chat = scriptedChat({ calls });
    await runSquadOrchestration(baseInput({ chat }));

    const decomposeCall = calls.find((c) => c.msgs[0]?.content.includes("拆解"));
    expect(decomposeCall?.msgs[0].content).not.toContain("团队既往经验");
  });
});
