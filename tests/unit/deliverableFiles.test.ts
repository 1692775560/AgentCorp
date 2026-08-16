/**
 * 交付文件提取（deliverableFiles）单测：围栏提取、语言映射、
 * 失败子任务不落文件、汇总文件恒在。
 */
import { describe, it, expect } from "vitest";
import { buildDeliverableFiles } from "../../src/engine/squad/deliverableFiles";
import type { SubTaskResult } from "../../src/engine/squad/squadOrchestration";

function st(title: string, output: string | null): SubTaskResult {
  return {
    title,
    assigneeId: "m1",
    assignedBy: "decompose",
    approved: Boolean(output),
    rounds: 1,
    output,
    verdict: "",
    ...(output === null ? { error: "失败" } : {}),
  };
}

describe("buildDeliverableFiles", () => {
  it("HTML 围栏 → .html 文件（可直接运行）", () => {
    const files = buildDeliverableFiles(
      [st("开发页面", "做好了：\n```html\n<!DOCTYPE html><html></html>\n```")],
      "汇总",
    );
    expect(files.map((f) => f.name)).toEqual(["00-交付汇总.md", "01-开发页面.html"]);
    expect(files[1].content).toContain("<!DOCTYPE html>");
  });

  it("无围栏产出 → .md 全文", () => {
    const files = buildDeliverableFiles([st("调研报告", "纯文字结论")], "汇总");
    expect(files[1].name).toBe("01-调研报告.md");
    expect(files[1].content).toBe("纯文字结论");
  });

  it("多个同语言围栏 → 序号区分", () => {
    const files = buildDeliverableFiles(
      [st("脚本", "```js\nconsole.log(1)\n```\n```js\nconsole.log(2)\n```")],
      "汇总",
    );
    expect(files.map((f) => f.name)).toEqual([
      "00-交付汇总.md",
      "01-脚本.js",
      "01-脚本-2.js",
    ]);
  });

  it("失败子任务（output=null）不落文件，汇总恒在", () => {
    const files = buildDeliverableFiles([st("坏任务", null)], "汇总");
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("00-交付汇总.md");
  });

  it("文件名安全化：非法字符被移除", () => {
    const files = buildDeliverableFiles([st('a/b:c*d?"<>|e', "内容")], "汇总");
    expect(files[1].name).toBe("01-abcde.md");
  });
});
