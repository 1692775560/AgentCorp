// @vitest-environment jsdom
/**
 * tests/unit/kanban-placeholder.test.tsx
 *
 * 回归测试：/kanban 路由缺失导致的「点开报错/空白」修复的渲染兜底验证。
 *
 * 修复内容（工程师已落盘）：
 *   1) src/App.tsx 注册 <Route path="kanban" element={<Kanban />} />（lazy 引入）。
 *   2) src/pages/Kanban/index.tsx 新增「即将上线」占位页，默认导出 Kanban 组件。
 *   3) src/i18n/locales/{zh,en}/common.json 的 kanban 块补齐
 *      comingSoon / placeholderDesc / taskLinkedHint（title 已有）。
 *
 * 本测试在 jsdom 中渲染 <Kanban />（用真实 react-router-dom 的 <MemoryRouter>
 * 包裹，从而让 useSearchParams 真正生效，验证深链 ?taskId= 读取路径），
 * 并 mock react-i18next 的 useTranslation（沿用项目既有范式），断言：
 *   - 默认渲染：徽标「即将上线」(kanban.comingSoon) + 标题 (kanban.title)
 *     + 占位说明 (kanban.placeholderDesc) 均出现在 DOM；
 *   - 深链 ?taskId=abc123：渲染 kanban.taskLinkedHint 且文案含 abc123
 *     （证明 Chat 创建任务的深链不是坏链）；
 *   - 无 taskId 时不渲染深链提示块。
 *
 * 运行：env -u NODE_OPTIONS npx vitest run tests/unit/kanban-placeholder.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

// 与 zh/common.json 的 kanban 块保持一致的受控映射（含 {{taskId}} 插值模板）。
// 组件若误用了不存在的 key，这里会回退为 key 本身，从而被下方断言捕获。
const zhKanban: Record<string, string> = {
  'kanban.title': '任务看板',
  'kanban.comingSoon': '即将上线',
  'kanban.placeholderDesc': '任务看板正在打磨中，拖拽式协作看板很快与你见面。',
  'kanban.taskLinkedHint': '你刚创建的任务 {{taskId}} 将在任务看板上线后在此显示。',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = zhKanban[key] ?? key;
      if (opts && typeof opts === 'object' && 'taskId' in opts) {
        return template.replace(/\{\{\s*taskId\s*\}\}/g, String(opts.taskId));
      }
      return template;
    },
    i18n: { language: 'zh' },
  }),
}));

import Kanban from '@/pages/Kanban';

// 满足 React 18+ act 环境警告。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

describe('Kanban 占位页 · 渲染与深链', () => {
  it('默认渲染：徽标「即将上线」+ 标题「任务看板」+ 占位说明均出现', () => {
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <Kanban />
      </MemoryRouter>,
    );
    expect(screen.getByText('即将上线')).toBeInTheDocument();
    expect(screen.getByText('任务看板')).toBeInTheDocument();
    expect(
      screen.getByText('任务看板正在打磨中，拖拽式协作看板很快与你见面。'),
    ).toBeInTheDocument();
  });

  it('深链 ?taskId=abc123：显示 taskLinkedHint 且文案含 abc123（深链不坏）', () => {
    render(
      <MemoryRouter initialEntries={['/kanban?taskId=abc123']}>
        <Kanban />
      </MemoryRouter>,
    );
    const hint = screen.getByText(/abc123/);
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).toContain('abc123');
  });

  it('无 taskId 时不渲染深链提示块', () => {
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <Kanban />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/abc123/)).not.toBeInTheDocument();
  });
});
