/**
 * zipTaskDeliverables 单测：macOS 走 ditto、目录缺失/为空如实报错。
 * child_process.execFile 与配置目录均 mock，不真打包。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const execFileMock = vi.fn(
  (_cmd: string, _args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as (
      err: Error | null,
      result: { stdout: string; stderr: string },
    ) => void;
    cb(null, { stdout: "", stderr: "" });
  },
);

vi.mock("child_process", () => ({ execFile: execFileMock }));

let configDir = "";
vi.mock("../../electron/utils/paths", () => ({
  getOpenClawConfigDir: () => configDir,
}));

const { zipTaskDeliverables, findHtmlDeliverable } = await import("../../electron/utils/deliverables");

beforeEach(() => {
  execFileMock.mockClear();
  configDir = mkdtempSync(join(tmpdir(), "zip-deliverables-"));
});

describe("zipTaskDeliverables", () => {
  it("目录有文件 → 调 ditto 打包并返回 zip 路径", async () => {
    const dir = join(configDir, "deliverables", "task-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "hello");

    const { zipPath } = await zipTaskDeliverables("task-1");

    expect(zipPath).toBe(join(configDir, "deliverables", "task-1.zip"));
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    if (process.platform === "darwin") {
      expect(cmd).toBe("ditto");
      expect(args).toContain("-c");
      expect(args[args.length - 2]).toBe(dir);
      expect(args[args.length - 1]).toBe(zipPath);
    }
  });

  it("目录不存在 → 抛错「交付目录不存在」", async () => {
    await expect(zipTaskDeliverables("task-missing")).rejects.toThrow("交付目录不存在");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("目录为空 → 抛错「交付目录为空」", async () => {
    mkdirSync(join(configDir, "deliverables", "task-empty"), { recursive: true });
    await expect(zipTaskDeliverables("task-empty")).rejects.toThrow("交付目录为空");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("taskId 含非法字符 → 安全化后再定位目录", async () => {
    // sanitizeFileName 会先取最后一段再清洗：task/a:b → a_b
    const dir = join(configDir, "deliverables", "a_b");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.md"), "x");
    const { zipPath } = await zipTaskDeliverables("task/a:b");
    expect(zipPath).toBe(join(configDir, "deliverables", "a_b.zip"));
  });
});

describe("findHtmlDeliverable", () => {
  it("目录里有 HTML → 返回完整路径（多个取排序第一个）", async () => {
    const dir = join(configDir, "deliverables", "task-html");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "b.html"), "<html>b</html>");
    writeFileSync(join(dir, "a.html"), "<html>a</html>");
    writeFileSync(join(dir, "notes.md"), "not html");

    const found = await findHtmlDeliverable("task-html");
    expect(found).toBe(join(dir, "a.html"));
  });

  it("没有 HTML → null；目录不存在 → null", async () => {
    const dir = join(configDir, "deliverables", "task-md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "only.md"), "md");
    expect(await findHtmlDeliverable("task-md")).toBeNull();
    expect(await findHtmlDeliverable("task-gone")).toBeNull();
  });
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
});
