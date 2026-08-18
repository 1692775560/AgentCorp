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
  calls?: { agentId: string; msgs: ChatMessage[] }[];
}): ChatFn {
  let execIdx = 0;
  let reviewIdx = 0;
  return async (agentId, msgs) => {
    script.calls?.push({ agentId, msgs });
    const sys = msgs[0]?.content ?? "";
    // 新步骤标记词先行判定（与 拆解/汇总/审阅 互不冲突）
    if (sys.includes("批量解答")) return script.kickoffAnswer ?? "已解答。";
    if (sys.includes("开工确认")) return script.kickoff ? script.kickoff(agentId) : "OK";
    if (sys.includes("交叉评审")) return script.crossReview ? script.crossReview(agentId) : "OK";
    if (sys.includes("重规划")) return script.replan ?? "OK";
    if (sys.includes("拆解")) return script.decompose ?? "[]";
    if (sys.includes("汇总")) return script.summarize ?? "汇总交付物";
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
