// @vitest-environment jsdom
/**
 * tests/unit/workbench-empty-state.test.tsx
 *
 * 回归测试：WorkbenchEmptyState 重构后的三段式结构。
 *
 * 旧结构（8 个快捷 chips + 8 张建议卡 + 3 列技巧面板）已移除，新结构为：
 *   上方：主问候「有什么我可以帮你的？」（h2，含 Gateway 离线徽标）
 *   中间（三层，极简）：
 *         · 核心主张手写体「不追最强，只找最配」
 *         · 三核心词「招募 · 面试 · 考评」（无英文 caption、无解释 tagline）
 *         · 哲学观短句「合拍，比满分更重要。」
 *   下方：ChatInput（在 Chat 页底部，本组件不渲染）
 *
 * 本测试保留 a11y 校验意图：标题语义角色、三段核心内容文本、三个核心功能、
 * 以及 axe 无障碍扫描。
 *
 * 运行：env -u NODE_OPTIONS npx vitest run tests/unit/workbench-empty-state.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { axe } from 'vitest-axe';

// 用可控的引用对象驱动 gateway 状态，避免加载真实的 electron/IPC 依赖链。
const { gatewayRef } = vi.hoisted(() => ({ gatewayRef: { running: false } }));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (s: { status: { state: string; port: number } }) => unknown) =>
    selector({ status: { state: gatewayRef.running ? 'running' : 'stopped', port: 18789 } }),
}));

import { WorkbenchEmptyState } from '@/components/workbench/workbench-empty-state';

// 满足 React 18+ act 环境警告。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  gatewayRef.running = false;
});

afterEach(() => {
  cleanup();
});

describe('WorkbenchEmptyState · 三段式结构', () => {
  it('渲染主问候标题「有什么我可以帮你的？」作为 h2', () => {
    render(<WorkbenchEmptyState />);
    const heading = screen.getByRole('heading', { level: 2, name: '有什么我可以帮你的？' });
    expect(heading).toBeInTheDocument();
  });

  it('渲染核心主张「不追最强，只找最配」（手写体主标语）', () => {
    render(<WorkbenchEmptyState />);
    expect(screen.getByText('不追最强，只找最配')).toBeInTheDocument();
  });

  it('渲染三核心功能极简中文词：招募 / 面试 / 考评', () => {
    render(<WorkbenchEmptyState />);
    // 名称（无英文 caption、无解释性 tagline）
    expect(screen.getByText('招募')).toBeInTheDocument();
    expect(screen.getByText('面试')).toBeInTheDocument();
    expect(screen.getByText('考评')).toBeInTheDocument();
  });

  it('渲染哲学观短句「合拍，比满分更重要。」', () => {
    render(<WorkbenchEmptyState />);
    expect(
      screen.getByText(/合拍，比满分更重要/),
    ).toBeInTheDocument();
  });

  it('Gateway 离线时展示离线徽标，运行时隐藏', () => {
    const { rerender } = render(<WorkbenchEmptyState />);
    expect(screen.getByText(/Gateway 离线/)).toBeInTheDocument();

    gatewayRef.running = true;
    rerender(<WorkbenchEmptyState />);
    expect(screen.queryByText(/Gateway 离线/)).not.toBeInTheDocument();
  });

  it('通过 axe 无障碍扫描，无违规项', async () => {
    const { container } = render(<WorkbenchEmptyState />);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
