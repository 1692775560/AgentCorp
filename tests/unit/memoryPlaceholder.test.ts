/**
 * tests/unit/memoryPlaceholder.test.ts
 *
 * Memory 页文档占位识别（src/lib/memory-placeholder.ts）：
 * - HEARTBEAT.md 模板占位 → 友好说明（不甩原始模板给用户）；
 * - 空文件 / 只剩 markdown 标点残渣 → 「暂无内容」；
 * - 正常文档 → null（原样渲染）。
 */
import { describe, it, expect } from "vitest";
import { placeholderNoteForFile } from "@/lib/memory-placeholder";

const HEARTBEAT_STUB = `# HEARTBEAT.md Template

\`\`\`markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`
`;

describe("placeholderNoteForFile", () => {
  it("HEARTBEAT.md 模板占位 → 周期任务说明", () => {
    const note = placeholderNoteForFile("HEARTBEAT.md", HEARTBEAT_STUB);
    expect(note).toContain("心跳任务模板");
  });

  it("HEARTBEAT.md 已有真实任务 → 不当占位（原样渲染）", () => {
    const real = "# Heartbeat\n\n- 每天 9 点汇总昨日任务进展";
    expect(placeholderNoteForFile("HEARTBEAT.md", real)).toBeNull();
  });

  it("空文件 → 「暂无内容」", () => {
    expect(placeholderNoteForFile("MEMORY.md", "")).toBe("暂无内容。");
    expect(placeholderNoteForFile("MEMORY.md", "   \n\n  ")).toBe("暂无内容。");
  });

  it("只剩 markdown 标点残渣（如 '- - **'）→ 「暂无内容」", () => {
    expect(placeholderNoteForFile("MEMORY.md", "- - **")).toBe("暂无内容。");
    expect(placeholderNoteForFile("notes.md", "# > ** --")).toBe("暂无内容。");
  });

  it("正常文档 → null", () => {
    const content = "# SOUL.md\n\n## 团队角色\n\n负责 UI 设计。";
    expect(placeholderNoteForFile("SOUL.md", content)).toBeNull();
  });

  it("其他文件即使提到 keep this file empty 也不误判", () => {
    // 非 HEARTBEAT.md 的文件含该字样且有其他可见文字 → 正常渲染
    const content = "keep this file empty 是心跳模板的说明文字，本文档另有内容。";
    expect(placeholderNoteForFile("AGENTS.md", content)).toBeNull();
  });
});
