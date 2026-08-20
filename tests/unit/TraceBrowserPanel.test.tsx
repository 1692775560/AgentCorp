// @vitest-environment jsdom
/**
 * tests/unit/TraceBrowserPanel.test.tsx
 *
 * 协作 trace 浏览面板的 DOM 测试：
 *   - 空列表：显示「尚无记录」诚实降级，不伪造；
 *   - 有列表：渲染每条 trace 概览（rootSessionId / recordCount / 时间）；
 *   - 点击展开：调详情 API → 渲染 records 的 span 行；
 *   - 再点折叠：清空 records；
 *   - 主进程不可达（fetch failed）：显示「桌面端使用」提示。
 *   - taskId prop（团队任务「协作轨迹」入口）：列表/详情请求带过滤参数 + 过滤徽标。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const refs = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: refs.fetchMock,
}));

import { TraceBrowserPanel } from '@/components/evaluation/TraceBrowserPanel';

beforeEach(() => {
  refs.fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
});

function mockListOnce(traces: unknown[]) {
  refs.fetchMock.mockResolvedValueOnce({ traces });
}

function mockDetailOnce(rootSessionId: string, records: unknown[]) {
  refs.fetchMock.mockResolvedValueOnce({ rootSessionId, records });
}

describe('TraceBrowserPanel', () => {
  it('空列表：诚实显示「尚无协作 trace 记录」', async () => {
    mockListOnce([]);
    const { findByText } = render(<TraceBrowserPanel />);
    expect(
      await findByText(/尚无协作 trace 记录/),
    ).toBeInTheDocument();
  });

  it('有列表：渲染每条 trace 概览', async () => {
    mockListOnce([
      {
        rootSessionId: 'root-aaa',
        fileName: 'root-aaa.jsonl',
        recordCount: 3,
        firstSentAt: '2025-01-01T00:00:00Z',
        lastSentAt: '2025-01-01T12:00:00Z',
        sizeBytes: 1024,
      },
    ]);
    const { findByText } = render(<TraceBrowserPanel />);
    expect(await findByText('root-aaa')).toBeInTheDocument();
    expect(await findByText(/3 条/)).toBeInTheDocument();
  });

  it('点击展开 → 调详情 API → 渲染 span 行；再点折叠', async () => {
    mockListOnce([
      {
        rootSessionId: 'root-x',
        fileName: 'root-x.jsonl',
        recordCount: 1,
        firstSentAt: '2025-01-01T00:00:00Z',
        lastSentAt: '2025-01-01T00:00:00Z',
        sizeBytes: 100,
      },
    ]);
    mockDetailOnce('root-x', [
      {
        trace_id: 't-1',
        task_id: 'task-1',
        parent_task_id: null,
        delegator: 'agent:leader',
        delegatee: 'agent:worker',
        round: 1,
        kind: 'message',
        state: 'completed',
        rework_of: null,
        channel: 'internal-rpc',
        sent_at: '2025-01-01T00:00:00Z',
        completed_at: '2025-01-01T00:00:00Z',
        summary: '把需求拆成三个子任务',
        session_key: 'agent:leader:sess-x',
        root_session_id: 'root-x',
        trigger: 'spawn',
        cost_usd: 0.0021,
        tokens: 1200,
        latency_ms: 480,
      },
    ]);
    const { findByText, queryByText } = render(<TraceBrowserPanel />);
    const item = await findByText('root-x');
    fireEvent.click(item);
    // 详情渲染：summary + delegator→delegatee + 成本
    expect(await findByText('把需求拆成三个子任务')).toBeInTheDocument();
    expect(await findByText('agent:leader → agent:worker')).toBeInTheDocument();
    expect(await findByText('1200 tok')).toBeInTheDocument();
    // 折叠
    fireEvent.click(item);
    await waitFor(() => {
      expect(queryByText('把需求拆成三个子任务')).not.toBeInTheDocument();
    });
  });

  it('主进程不可达：显示「桌面端使用」提示，不崩溃', async () => {
    refs.fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { findByText } = render(<TraceBrowserPanel />);
    expect(
      await findByText(/主进程不可达/),
    ).toBeInTheDocument();
  });

  it('刷新按钮：再次拉取列表', async () => {
    mockListOnce([]);
    const { findByText, findByRole } = render(<TraceBrowserPanel />);
    await findByText(/尚无协作 trace 记录/);
    mockListOnce([
      {
        rootSessionId: 'root-after-refresh',
        fileName: 'root-after-refresh.jsonl',
        recordCount: 1,
        firstSentAt: '2025-01-02T00:00:00Z',
        lastSentAt: '2025-01-02T00:00:00Z',
        sizeBytes: 50,
      },
    ]);
    const refreshBtn = await findByRole('button', { name: /刷新/ });
    fireEvent.click(refreshBtn);
    expect(await findByText('root-after-refresh')).toBeInTheDocument();
  });

  it('taskId prop：列表/详情请求带 taskId 过滤参数，并显示过滤徽标', async () => {
    mockListOnce([
      {
        rootSessionId: 'root-squad',
        fileName: 'root-squad.jsonl',
        recordCount: 2,
        firstSentAt: '2025-01-01T00:00:00Z',
        lastSentAt: '2025-01-01T01:00:00Z',
        sizeBytes: 256,
      },
    ]);
    mockDetailOnce('root-squad', []);
    const { findByText } = render(<TraceBrowserPanel taskId="task-42" />);
    // 过滤徽标可见
    expect(await findByText('任务 task-42')).toBeInTheDocument();
    // 列表请求带过滤参数
    expect(refs.fetchMock).toHaveBeenCalledWith('/api/traces?taskId=task-42');
    // 展开详情同样带过滤参数
    fireEvent.click(await findByText('root-squad'));
    await waitFor(() => {
      expect(refs.fetchMock).toHaveBeenCalledWith('/api/traces/root-squad?taskId=task-42');
    });
  });

  it('taskId prop：无记录时提示按任务过滤的空态文案', async () => {
    mockListOnce([]);
    const { findByText } = render(<TraceBrowserPanel taskId="task-42" />);
    expect(await findByText(/该任务尚无协作 trace 记录/)).toBeInTheDocument();
  });
});
