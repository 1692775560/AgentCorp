/**
 * src/engine/squad/outputCheck.ts
 * 成员产出的机器校验（纯函数，可单测）——把「能跑/结构完整」从审阅口径
 * 变成机器事实，机检不过直接记 REWORK，不消耗 LLM 审阅。
 *
 * 校验项按工种分级：
 * - code：必须有代码块；HTML 标签闭合配对；JS 语法可编译（new Function
 *   只编译不执行，无副作用）；CSS 花括号配对。
 * - long/short：暂无机检（结构完整性由 requiredSections 机检覆盖）。
 *
 * 保守原则：拿不准（TS/ESM/无法解析）一律放行，只拦确定性的残缺。
 */

/** 提取 fenced 代码块：```lang … ```。 */
function extractCodeBlocks(output: string): { lang: string; code: string }[] {
  const blocks: { lang: string; code: string }[] = [];
  const re = /```([a-zA-Z]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    blocks.push({ lang: (m[1] || '').toLowerCase(), code: m[2] });
  }
  return blocks;
}

/** 需要闭合配对的常见 HTML 标签（void 标签不在其列）。 */
const PAIRED_TAGS = new Set([
  'html', 'head', 'body', 'div', 'span', 'p', 'ul', 'ol', 'li', 'table', 'thead',
  'tbody', 'tr', 'td', 'th', 'script', 'style', 'section', 'article', 'header',
  'footer', 'main', 'nav', 'form', 'button', 'select', 'textarea', 'h1', 'h2',
  'h3', 'h4', 'a', 'strong', 'em', 'title',
]);

/** HTML 标签配对检查：返回未闭合/错位的标签名（去重，最多 3 个）。 */
export function checkHtmlTagBalance(code: string): string[] {
  const stack: string[] = [];
  const issues = new Set<string>();
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const tag = m[1].toLowerCase();
    if (!PAIRED_TAGS.has(tag)) continue;
    const isClose = m[0].startsWith('</');
    const selfClose = m[2] === '/';
    if (selfClose) continue;
    if (!isClose) {
      stack.push(tag);
    } else {
      const top = stack[stack.length - 1];
      if (top === tag) {
        stack.pop();
      } else if (stack.includes(tag)) {
        // 错位闭合：如 <div><span></div>——弹出至匹配处并记一笔
        issues.add(tag);
        while (stack.length && stack[stack.length - 1] !== tag) stack.pop();
        stack.pop();
      } else {
        issues.add(tag);
      }
    }
  }
  for (const tag of stack) issues.add(tag);
  return Array.from(issues).slice(0, 3);
}

/**
 * JS 语法可编译性检查：new Function 仅编译不执行，语法错误抛 SyntaxError。
 * 含顶层 import/export 的 ESM 代码 new Function 必抛，直接放行（拿不准不拦）。
 */
export function checkJsSyntax(code: string): string | null {
  if (/^\s*(import|export)\s/m.test(code)) return null;
  try {
    new Function(code);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** CSS 花括号配对检查。 */
export function checkCssBraces(code: string): boolean {
  let depth = 0;
  for (const ch of code) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * 代码类子任务产出的机检：返回问题列表（空数组 = 通过）。
 * 问题描述面向返工：成员按列表逐条修复。
 */
export function checkCodeOutput(output: string): string[] {
  const blocks = extractCodeBlocks(output);
  if (blocks.length === 0) {
    // 整篇没有代码块但肉眼像 HTML（裸标签交付）→ 按 HTML 校验全文
    if (/<(html|body|div|!doctype)/i.test(output)) {
      const bad = checkHtmlTagBalance(output);
      return bad.length ? [`HTML 标签未闭合/错位：${bad.join('、')}`] : [];
    }
    return ['代码类子任务的产出未包含代码块（``` 围栏）'];
  }
  const issues: string[] = [];
  for (const { lang, code } of blocks) {
    if (lang === 'html' || (!lang && /<[a-z]/i.test(code))) {
      const bad = checkHtmlTagBalance(code);
      if (bad.length) issues.push(`HTML 标签未闭合/错位：${bad.join('、')}`);
    } else if (lang === 'js' || lang === 'javascript') {
      const err = checkJsSyntax(code);
      if (err) issues.push(`JS 语法错误：${err.slice(0, 120)}`);
    } else if (lang === 'css') {
      if (!checkCssBraces(code)) issues.push('CSS 花括号不配对');
    }
    // ts/tsx/其他语言：拿不准，放行
    if (issues.length >= 3) break;
  }
  return issues.slice(0, 3);
}
