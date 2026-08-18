/**
 * tests/unit/a2a-timeline.test.ts
 *
 * A2A 协作时间线解析（src/lib/a2a-timeline.ts）：
 * - parseA2aRoute：a2a:from → to 解析，非 A2A 事件返回 null；
 * - extractA2aParticipants：按首现顺序去重收集 delegator/delegatee；
 * - summarizeA2aEvents：轮次取最大、PASS/REWORK 计数。
 */
import { describe, it, expect } from "vitest";
import { parseA2aRoute, extractA2aParticipants, summarizeA2aEvents } from "@/lib/a2a-timeline";
import type { TaskExecutionEvent } from "@/types/task";

function ev(type: string, content: string): TaskExecutionEvent {
  return { type, content, createdAt: new Date().toISOString(), status: "done" } as TaskExecutionEvent;
}

describe("parseA2aRoute", () => {
  it("解析 a2a:delegator → delegatee", () => {
    expect(parseA2aRoute("a2a:leader-1 → member-2")).toEqual({ from: "leader-1", to: "member-2" });
  });

  it("非 A2A 事件返回 null", () => {
    expect(parseA2aRoute("system")).toBeNull();
    expect(parseA2aRoute(undefined)).toBeNull();
  });
});

describe("extractA2aParticipants", () => {
  it("按首现顺序收集 delegator 与 delegatee，去重", () => {
    const events = [
      ev("a2a:leader → m1", "【第1轮】拆解"),
      ev("a2a:leader → m2", "【第1轮】拆解"),
      ev("a2a:m1 → leader", "【第1轮】交付"),
      ev("a2a:leader → m1", "【第2轮】返工"),
    ];
    expect(extractA2aParticipants(events)).toEqual(["leader", "m1", "m2"]);
  });

  it("无 A2A 事件 → 空数组", () => {
    expect(extractA2aParticipants([ev("system", "创建任务")])).toEqual([]);
  });
});

describe("summarizeA2aEvents", () => {
  it("统计轮次（取最大）、PASS、REWORK", () => {
    const events = [
      ev("a2a:leader → m1", "【第1轮】子任务分派"),
      ev("a2a:m1 → leader", "【第1轮】交付，leader 判 REWORK"),
      ev("a2a:leader → m1", "【第2轮】返工要求"),
      ev("a2a:m1 → leader", "【第2轮】交付，leader 判 PASS"),
      ev("system", "无关事件"),
    ];
    expect(summarizeA2aEvents(events)).toEqual({ rounds: 2, pass: 1, rework: 1, total: 4 });
  });

  it("空事件 → 全 0", () => {
    expect(summarizeA2aEvents([])).toEqual({ rounds: 0, pass: 0, rework: 0, total: 0 });
  });
});
