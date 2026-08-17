/**
 * src/lib/memory-placeholder.ts
 * Memory 页文档占位识别（纯函数）。
 *
 * 背景：agent 工作区里的 HEARTBEAT.md 是 OpenClaw 的周期任务模板——
 * 内容保持为空表示「不做周期自查」，这是设计而非损坏；MEMORY.md 偶发
 * 只剩 markdown 标点残渣（如 "- - **"）。直接把这类原文渲染出来会像坏掉了，
 * 这里识别出来换成友好说明。原始内容仍可通过「Raw」开关查看。
 */

/** 去掉 markdown 标点/空白后的可见文字。 */
function visibleText(content: string): string {
  return content.replace(/[#*`>\-_[\]():.!|~]/g, '').replace(/\s+/g, '');
}

/**
 * 若该文件是「占位模板/空壳文档」，返回面向用户的友好说明；否则返回 null。
 */
export function placeholderNoteForFile(relativePath: string, content: string): string | null {
  const base = relativePath.split('/').pop() ?? relativePath;

  if (base === 'HEARTBEAT.md' && /keep this file empty/i.test(content)) {
    return '这是心跳任务模板：保持为空，agent 就不会做周期性自查。想让它定期检查某件事（比如每天早上汇总进展）时，再把任务写进这个文件。';
  }

  // 空文件，或去掉 markdown 标点后没有任何可见文字（如残渣 "- - **"）
  if (visibleText(content).length === 0) {
    return '暂无内容。';
  }

  return null;
}
