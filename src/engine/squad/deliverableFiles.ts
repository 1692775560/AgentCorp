/**
 * src/engine/squad/deliverableFiles.ts
 * 把编排结果落成真实文件（纯函数，可单测）。
 *
 * 背景：交付物此前只有 leader 综述进看板，成员写出的代码全文只存在于
 * 运行期内存，用户「看不到代码」。这里把每个子任务的完整产出提取为文件
 * 列表，由调用方（autoWorker）经 IPC 落盘；HTML 文件可直接双击运行。
 *
 * 提取规则：
 *   - 产出中含代码围栏时按语言落文件：html→.html（可直接运行）、
 *     js/javascript→.js、css→.css、py/python→.py、ts/typescript→.ts，
 *     其它语言或无围栏 → 全文存 .md。
 *   - 一个子任务多个同语言围栏 → 追加序号区分。
 *   - 最前面固定补一份 00-交付汇总.md（leader 汇总全文）。
 */
import type { SubTaskResult } from './squadOrchestration';

export interface DeliverableFile {
  name: string;
  content: string;
}

const LANG_EXT: Record<string, string> = {
  html: '.html',
  htm: '.html',
  javascript: '.js',
  js: '.js',
  typescript: '.ts',
  ts: '.ts',
  css: '.css',
  python: '.py',
  py: '.py',
  json: '.json',
};

/** 文件名安全化：去非法字符、截断，保证跨平台可写。 */
function slug(text: string, max = 24): string {
  const cleaned = text
    .replace(/[\\/:*?"<>|\n\r`#]/g, '')
    .trim()
    .slice(0, max)
    .replace(/\.+$/, '');
  return cleaned || 'untitled';
}

/** 提取产出中的代码围栏：[{lang, code}]。 */
function extractCodeFences(output: string): Array<{ lang: string; code: string }> {
  const fences: Array<{ lang: string; code: string }> = [];
  const re = /```([\w+-]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const code = m[2].replace(/\n$/, '');
    if (code.trim()) fences.push({ lang: (m[1] || '').toLowerCase(), code });
  }
  return fences;
}

/**
 * 从编排结果构建交付文件列表。无任何有效产出时只返回汇总文件。
 */
export function buildDeliverableFiles(
  subtasks: SubTaskResult[],
  summary: string,
): DeliverableFile[] {
  const files: DeliverableFile[] = [
    { name: '00-交付汇总.md', content: summary },
  ];

  subtasks.forEach((st, i) => {
    if (!st.output) return; // 执行失败的子任务没有产出，不捏造文件
    const base = `${String(i + 1).padStart(2, '0')}-${slug(st.title)}`;
    const fences = extractCodeFences(st.output);
    const codeFences = fences.filter((f) => f.lang in LANG_EXT);

    if (codeFences.length === 0) {
      files.push({ name: `${base}.md`, content: st.output });
      return;
    }
    const perLangCount: Record<string, number> = {};
    for (const f of codeFences) {
      perLangCount[f.lang] = (perLangCount[f.lang] ?? 0) + 1;
      const suffix = perLangCount[f.lang] > 1 ? `-${perLangCount[f.lang]}` : '';
      files.push({ name: `${base}${suffix}${LANG_EXT[f.lang]}`, content: f.code });
    }
  });

  return files;
}
