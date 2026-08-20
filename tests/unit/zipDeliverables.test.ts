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

const { zipTaskDeliverables, findHtmlDeliverable, saveTaskDeliverables, listTaskDeliverables } = await import("../../electron/utils/deliverables");

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

  it("存在 index.html 时优先作为网站入口", async () => {
    const dir = join(configDir, "deliverables", "task-site");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a-page.html"), "<html>a</html>");
    writeFileSync(join(dir, "index.html"), "<html>index</html>");

    const found = await findHtmlDeliverable("task-site");
    expect(found).toBe(join(dir, "index.html"));
  });

  it("没有 HTML → null；目录不存在 → null", async () => {
    const dir = join(configDir, "deliverables", "task-md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "only.md"), "md");
    expect(await findHtmlDeliverable("task-md")).toBeNull();
    expect(await findHtmlDeliverable("task-gone")).toBeNull();
  });
});

describe("saveTaskDeliverables", () => {
  it("新一轮交付先清空旧文件，浏览器/ZIP 只拿到最新版本", async () => {
    const dir = join(configDir, "deliverables", "task-renew");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-旧版页面.html"), "<html>old</html>");
    writeFileSync(join(dir, "旧说明.md"), "old");

    const result = await saveTaskDeliverables("task-renew", [
      { name: "01-深色主题.html", content: "<html>new</html>" },
      { name: "00-交付汇总.md", content: "new summary" },
    ]);

    expect(result.saved.sort()).toEqual(["00-交付汇总.md", "01-深色主题.html"]);
    expect(result.failed).toEqual([]);
    const remaining = await listTaskDeliverables("task-renew");
    expect(remaining).toEqual(["00-交付汇总.md", "01-深色主题.html"]);
  });

  it("本轮 0 个文件要写入 → 不清空上一轮旧交付物", async () => {
    const dir = join(configDir, "deliverables", "task-empty-round");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "旧版.html"), "<html>old</html>");

    const result = await saveTaskDeliverables("task-empty-round", []);

    expect(result.saved).toEqual([]);
    expect(result.failed).toEqual([]);
    // 旧文件原样保留
    expect(await listTaskDeliverables("task-empty-round")).toEqual(["旧版.html"]);
  });

  it("单文件写入失败 → 跳过并记入 failed，不中断整批", async () => {
    // 预建同名目录，writeFile 必失败（EISDIR），用来模拟单文件失败
    const dir = join(configDir, "deliverables", "task-partial");
    mkdirSync(join(dir, "sub.md"), { recursive: true });
    const result = await saveTaskDeliverables("task-partial", [
      { name: "ok.md", content: "fine" },
      { name: "sub.md", content: "boom" },
      { name: "also-ok.md", content: "fine too" },
    ]);

    expect(result.saved).toEqual(["ok.md", "also-ok.md"]);
    expect(result.failed).toEqual(["sub.md"]);
    expect(await listTaskDeliverables("task-partial")).toEqual(["also-ok.md", "ok.md", "sub.md"]);
  });

  it("同批同名文件 → 后者追加 -2/-3 后缀，内容各自保留", async () => {
    const result = await saveTaskDeliverables("task-dup", [
      { name: "report.md", content: "v1" },
      { name: "report.md", content: "v2" },
      { name: "report.md", content: "v3" },
    ]);

    expect(result.saved).toEqual(["report.md", "report-2.md", "report-3.md"]);
    expect(result.failed).toEqual([]);
    const dir = result.dir;
    const { readFileSync } = await import("fs");
    expect(readFileSync(join(dir, "report.md"), "utf8")).toBe("v1");
    expect(readFileSync(join(dir, "report-2.md"), "utf8")).toBe("v2");
    expect(readFileSync(join(dir, "report-3.md"), "utf8")).toBe("v3");
  });
});

describe("listTaskDeliverables", () => {
  it("返回排序后的文件名列表；目录不存在 → 空数组", async () => {
    const dir = join(configDir, "deliverables", "task-list");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "b.py"), "print(1)");
    writeFileSync(join(dir, "a.html"), "<html/>");

    expect(await listTaskDeliverables("task-list")).toEqual(["a.html", "b.py"]);
    expect(await listTaskDeliverables("task-none")).toEqual([]);
  });
});

describe("路径穿越防护（taskId=.. 不得逃逸出 deliverables 目录）", () => {
  it("saveTaskDeliverables('..') 落进安全目录，绝不动配置根目录文件", async () => {
    // 配置根目录放哨兵文件：若穿越成功它会被「先清空旧文件」逻辑删掉
    const sentinel = join(configDir, "openclaw.json");
    writeFileSync(sentinel, "{}");

    const result = await saveTaskDeliverables("..", [{ name: "x.md", content: "x" }]);

    expect(result.saved).toEqual(["x.md"]);
    // 落点在 deliverables/untitled.md/ 内，不是配置根目录
    expect(result.dir).toBe(join(configDir, "deliverables", "untitled.md"));
    const { existsSync } = await import("fs");
    expect(existsSync(sentinel)).toBe(true);
  });

  it("listTaskDeliverables('..') 不列出配置根目录", async () => {
    writeFileSync(join(configDir, "openclaw.json"), "{}");
    expect(await listTaskDeliverables("..")).toEqual([]);
  });

  it("zipTaskDeliverables('..') 打包不到配置目录", async () => {
    await expect(zipTaskDeliverables("..")).rejects.toThrow("交付目录不存在");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("findHtmlDeliverable('..') 不在配置根目录找 HTML", async () => {
    writeFileSync(join(configDir, "evil.html"), "<html/>");
    expect(await findHtmlDeliverable("..")).toBeNull();
  });
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
});
