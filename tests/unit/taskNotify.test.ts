/**
 * tests/unit/taskNotify.test.ts
 *
 * 渲染端任务终态通知 helper（src/lib/task-notify.ts）：
 * - done/failed 生成正确的系统通知标题与正文（含任务标题）；
 * - IPC 不可用时静默降级（不抛错）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn(async () => ({ success: true }));

vi.mock("@/lib/api-client", () => ({
  invokeIpc: (...args: unknown[]) => invokeMock(...args),
}));

import { notifyTaskTerminal } from "@/lib/task-notify";

beforeEach(() => invokeMock.mockClear());

describe("notifyTaskTerminal", () => {
  it("done → 「任务完成，待验收」通知，带任务 id 与标题", async () => {
    notifyTaskTerminal("task-1", "done", "做一个计算器");
    // helper 内部是 void promise，等一拍让 IPC 调用落地
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeMock).toHaveBeenCalledWith("task:notify", {
      taskId: "task-1",
      title: "任务完成，待验收",
      body: "做一个计算器",
    });
  });

  it("failed → 「任务失败」通知，正文附失败原因", async () => {
    notifyTaskTerminal("task-2", "failed", "整理报表", "LLM 超时");
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeMock).toHaveBeenCalledWith("task:notify", {
      taskId: "task-2",
      title: "任务失败",
      body: "整理报表\nLLM 超时",
    });
  });

  it("IPC 抛错时静默降级，不影响调用方", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no ipc"));
    expect(() => notifyTaskTerminal("task-3", "done", "x")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
