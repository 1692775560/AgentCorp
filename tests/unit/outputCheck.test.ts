import { describe, expect, it } from 'vitest';

import {
  checkCodeOutput,
  checkCssBraces,
  checkHtmlTagBalance,
  checkJsSyntax,
} from '@/engine/squad/outputCheck';

describe('checkHtmlTagBalance', () => {
  it('闭合正常 → 无问题', () => {
    expect(checkHtmlTagBalance('<div><p>你好</p></div>')).toEqual([]);
    expect(checkHtmlTagBalance('<html><head><title>t</title></head><body><h1>x</h1></body></html>')).toEqual([]);
  });

  it('未闭合 / 错位闭合 → 报标签名', () => {
    expect(checkHtmlTagBalance('<div><p>你好</p>')).toEqual(['div']);
    expect(checkHtmlTagBalance('<div><span></div>')).toContain('div');
    expect(checkHtmlTagBalance('</div>')).toEqual(['div']);
  });

  it('void 标签与自闭合不误报', () => {
    expect(checkHtmlTagBalance('<div><img src="x"><br><input></div>')).toEqual([]);
  });
});

describe('checkJsSyntax', () => {
  it('语法正确 → null', () => {
    expect(checkJsSyntax('const a = 1; function f() { return a; }')).toBeNull();
  });

  it('语法错误 → 报错信息', () => {
    expect(checkJsSyntax('function {')).not.toBeNull();
  });

  it('ESM（顶层 import/export）放行不拦', () => {
    expect(checkJsSyntax('import x from "y"; export default x;')).toBeNull();
  });
});

describe('checkCssBraces', () => {
  it('配对 / 不配对', () => {
    expect(checkCssBraces('.a { color: red; }')).toBe(true);
    expect(checkCssBraces('.a { color: red;')).toBe(false);
    expect(checkCssBraces('}')).toBe(false);
  });
});

describe('checkCodeOutput', () => {
  it('正常代码块 → 通过', () => {
    const out = '如下：\n```html\n<div><p>ok</p></div>\n```';
    expect(checkCodeOutput(out)).toEqual([]);
  });

  it('无代码块且不像 HTML → 报缺代码块', () => {
    expect(checkCodeOutput('这是一段说明文字，没有代码。')).toEqual([
      '代码类子任务的产出未包含代码块（``` 围栏）',
    ]);
  });

  it('HTML 未闭合 → 报标签问题', () => {
    const out = '```html\n<div><span>x</div>\n```';
    expect(checkCodeOutput(out)[0]).toContain('HTML 标签未闭合');
  });

  it('JS 语法错误 → 报语法问题', () => {
    const out = '```js\nfunction {\n```';
    expect(checkCodeOutput(out)[0]).toContain('JS 语法错误');
  });

  it('TS / ESM 代码拿不准放行', () => {
    const out = '```ts\nimport { a } from "b";\nconst x: number = a;\n```';
    expect(checkCodeOutput(out)).toEqual([]);
  });

  it('裸 HTML（无围栏）也校验', () => {
    expect(checkCodeOutput('<div><p>x</p>')).toEqual(['HTML 标签未闭合/错位：div']);
  });
});
