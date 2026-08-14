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
});
