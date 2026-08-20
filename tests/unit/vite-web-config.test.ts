/**
 * tests/unit/vite-web-config.test.ts
 * vite.config.web.ts 的网络暴露面守卫：
 * web 预览 dev server 挂着无鉴权 LLM 代理（vite-plugin-llm-proxy），
 * 默认绑定必须是本机回环；绑 0.0.0.0 需经 WEB_HOST 显式声明。
 *
 * 用静态源码断言而非 import 配置：vite.config.web.ts 依赖 __dirname，
 * 在 vitest 的 ESM 模块加载器下不可靠；这里守的是「默认值不被改回去」。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const src = readFileSync(
  fileURLToPath(new URL('../../vite.config.web.ts', import.meta.url)),
  'utf8',
);

describe('vite.config.web 网络暴露面', () => {
  it('默认绑定 127.0.0.1，不得直接写死 0.0.0.0', () => {
    expect(src).not.toMatch(/host:\s*['"]0\.0\.0\.0['"]/);
    expect(src).toContain("'127.0.0.1'");
  });

  it('局域网放开必须走 WEB_HOST 环境变量（显式选择）', () => {
    expect(src).toContain('process.env.WEB_HOST');
  });
});
