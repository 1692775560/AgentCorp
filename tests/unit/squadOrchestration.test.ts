/**
 * 多 Agent 协同编排器单测：mock ChatFn（确定性脚本化回复），
 * 覆盖分解/指派/并行执行/审阅返工/汇总全链路与各兜底分支。
 */
import { describe, it, expect } from "vitest";
import {
  runSquadOrchestration,
  parseSubTasks,
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
  calls?: { agentId: string; msgs: ChatMessage[] }[];
}): ChatFn {
  let execIdx = 0;
  let reviewIdx = 0;
  return async (agentId, msgs) => {
    script.calls?.push({ agentId, msgs });
    const sys = msgs[0]?.content ?? "";
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

describe("runSquadOrchestration", () => {
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
    expect(result.traces).toHaveLength(8);
    expect(result.traces.some((t) => t.summary.includes("拆解任务为 2"))).toBe(true);
    expect(result.traces.filter((t) => t.state === "completed")).toHaveLength(3); // 2 审阅 PASS + 汇总
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
    const execCalls = calls.filter((c) => c.agentId === "m1");
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

  it("单成员执行失败不阻塞：记 error，其余子任务与汇总照常", async () => {
    const chat = scriptedChat({
      decompose: JSON.stringify([
        { title: "调研 A", instruction: "调研竞品 A", assigneeId: "m1" },
        { title: "调研 B", instruction: "调研竞品 B", assigneeId: "m2" },
      ]),
      execute: (agentId) => {
        if (agentId === "m1") throw new Error("LLM 超时");
        return "m2 的产出";
      },
    });
    const result = await runSquadOrchestration(baseInput({ chat }));

    const [s1, s2] = result.subtasks;
    expect(s1.error).toContain("LLM 超时");
    expect(s1.output).toBeNull();
    expect(s1.approved).toBe(false);
    expect(s2.approved).toBe(true);
    expect(result.traces.some((t) => t.state === "failed")).toBe(true);
    expect(result.deliverable).toBe("汇总交付物");
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
    const execCall = calls.find((c) => c.agentId === "m1");
    expect(execCall?.msgs[0].content).toContain("严谨的分析师");
  });
});
