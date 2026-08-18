import { describe, it, expect } from "vitest";
import {
  routeBySquadLeader,
  MIN_ROUTE_SCORE,
  type RoutingCandidate,
} from "../../src/engine/squad/squadRouting";
import type { RadarScore } from "../../src/types/evaluation";

function radar(p: Partial<RadarScore>): RadarScore {
  return {
    task: 0,
    quality: 0,
    comm: 0,
    creativity: 0,
    reliability: 0,
    cost: 0,
    ...p,
  };
}

describe("squad leader routing", () => {
  it("无在职成员 → leader 自留", () => {
    const d = routeBySquadLeader({
      taskText: "写一段文案",
      leaderId: "leader-1",
      candidates: [{ agentId: "m1", active: false }],
    });
    expect(d.leaderKept).toBe(true);
    expect(d.assigneeId).toBe("leader-1");
  });

  it("工种对口成员被优先选中（code 任务 → 高 reliability/cost 成员）", () => {
    const candidates: RoutingCandidate[] = [
      {
        agentId: "coder",
        active: true,
        jobType: "code",
        radar: radar({ reliability: 5, cost: 5, task: 4 }),
        userFit: 80,
      },
      {
        agentId: "writer",
        active: true,
        jobType: "text",
        radar: radar({ comm: 5, quality: 5 }),
        userFit: 70,
      },
    ];
    const d = routeBySquadLeader({
      taskText: "修复登录接口的 bug 并写单测",
      leaderId: "leader-1",
      candidates,
    });
    expect(d.jobType).toBe("code");
    expect(d.assigneeId).toBe("coder");
    expect(d.leaderKept).toBe(false);
    expect(d.score).toBeGreaterThanOrEqual(MIN_ROUTE_SCORE);
  });

  it("leader 自身不会被路由给自己（排除 leaderId）", () => {
    const d = routeBySquadLeader({
      taskText: "设计一张海报",
      leaderId: "leader-1",
      candidates: [
        {
          agentId: "leader-1",
          active: true,
          jobType: "image",
          radar: radar({ creativity: 5 }),
          userFit: 99,
        },
        {
          agentId: "designer",
          active: true,
          jobType: "image",
          radar: radar({ creativity: 4, task: 3 }),
          userFit: 60,
        },
      ],
    });
    expect(d.assigneeId).toBe("designer");
  });

  it("所有成员分数过低 → leader 自留", () => {
    const d = routeBySquadLeader({
      taskText: "随便做点什么",
      leaderId: "leader-1",
      candidates: [{ agentId: "m1", active: true, radar: radar({}), userFit: 0 }],
    });
    expect(d.leaderKept).toBe(true);
    expect(d.assigneeId).toBe("leader-1");
  });

  it("无 leader 时指派最高分成员", () => {
    const d = routeBySquadLeader({
      taskText: "写一篇产品介绍",
      leaderId: null,
      candidates: [
        {
          agentId: "writer",
          active: true,
          jobType: "text",
          radar: radar({ comm: 5, quality: 5, task: 4 }),
          userFit: 85,
        },
      ],
    });
    expect(d.assigneeId).toBe("writer");
    expect(d.leaderKept).toBe(false);
  });

  it("绩效加权（DyLAN）：画像相同时 approvedRate 高的候选胜出", () => {
    const mk = (agentId: string, approvedRate: number): RoutingCandidate => ({
      agentId,
      active: true,
      radar: radar({ task: 4, comm: 4, quality: 4 }),
      userFit: 70,
      performance: { tasks: 10, approvedRate, avgRounds: 1 },
    });
    const d = routeBySquadLeader({
      taskText: "写一段文案",
      leaderId: "leader-1",
      candidates: [mk("low", 0.1), mk("high", 0.9)],
    });
    expect(d.assigneeId).toBe("high");
  });

  it("绩效加权可逆转画像劣势：通过率 1.0 的低画像成员击败通过率 0 的高画像成员", () => {
    const base: RoutingCandidate = {
      agentId: "strong",
      active: true,
      radar: radar({ task: 5, comm: 5, quality: 5 }),
      userFit: 90,
      performance: { tasks: 20, approvedRate: 0, avgRounds: 3 },
    };
    const weak: RoutingCandidate = {
      agentId: "weak",
      active: true,
      radar: radar({ task: 4, comm: 4, quality: 4 }),
      userFit: 70,
      performance: { tasks: 20, approvedRate: 1, avgRounds: 1 },
    };
    // 无绩效时 strong 必胜
    const strip = (c: RoutingCandidate): RoutingCandidate => {
      const { performance: _p, ...rest } = c;
      return rest;
    };
    const dNoPerf = routeBySquadLeader({
      taskText: "写一段文案",
      leaderId: "leader-1",
      candidates: [strip(base), strip(weak)],
    });
    expect(dNoPerf.assigneeId).toBe("strong");
    // 有绩效时 weak（×1.0）逆转 strong（×0.6）
    const dPerf = routeBySquadLeader({
      taskText: "写一段文案",
      leaderId: "leader-1",
      candidates: [base, weak],
    });
    expect(dPerf.assigneeId).toBe("weak");
  });

  it("tasks===0 的新成员不罚：分数与无 performance 字段完全一致（回归）", () => {
    const baseCandidate = {
      agentId: "m1",
      active: true,
      radar: radar({ task: 4, comm: 4, quality: 4 }),
      userFit: 70,
    };
    const noPerf = routeBySquadLeader({
      taskText: "写一段文案",
      leaderId: "leader-1",
      candidates: [baseCandidate],
    });
    const newMember = routeBySquadLeader({
      taskText: "写一段文案",
      leaderId: "leader-1",
      candidates: [
        { ...baseCandidate, performance: { tasks: 0, approvedRate: 0, avgRounds: 0 } },
      ],
    });
    const perfect = routeBySquadLeader({
      taskText: "写一段文案",
      leaderId: "leader-1",
      candidates: [
        { ...baseCandidate, performance: { tasks: 5, approvedRate: 1, avgRounds: 1 } },
      ],
    });
    expect(newMember.score).toBe(noPerf.score); // 新成员不罚
    expect(perfect.score).toBe(noPerf.score); // approvedRate=1 → 系数 1.0，也不变
    expect(newMember.assigneeId).toBe("m1");
  });
});
