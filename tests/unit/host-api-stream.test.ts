// @vitest-environment jsdom
/**
 * tests/unit/host-api-stream.test.ts
 * hostApiStream（host-api.ts）：SSE 流的主进程代理渲染侧重组。
 * token 不下发渲染进程后，evaluate 等流式端点全靠这条通道——
 * meta/data/end/error 事件必须按 streamId 正确重组为 ReadableStream。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type StreamEvent =
  | { streamId: string; kind: 'meta'; status: number; ok: boolean }
  | { streamId: string; kind: 'data'; chunk: Uint8Array }
  | { streamId: string; kind: 'end' }
  | { streamId: string; kind: 'error'; message: string };

const refs = vi.hoisted(() => ({
  listener: null as null | ((ev: StreamEvent) => void),
  invoke: vi.fn(async () => ({ streamId: 's-1' })),
  unsubscribe: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ invokeIpc: vi.fn() }));
vi.mock('@/lib/telemetry', () => ({ trackUiEvent: vi.fn() }));
vi.mock('@/lib/browser-preview', () => ({ isBrowserPreviewMode: () => false }));

import { hostApiStream } from '@/lib/host-api';

beforeEach(() => {
  refs.listener = null;
  refs.invoke.mockClear();
  refs.unsubscribe.mockClear();
  (window as unknown as { electron: unknown }).electron = {
    ipcRenderer: {
      invoke: refs.invoke,
      on: (_channel: string, cb: (ev: StreamEvent) => void) => {
        refs.listener = cb;
        return refs.unsubscribe;
      },
    },
  };
});

const emit = (ev: StreamEvent) => refs.listener?.(ev);

/** invoke 是异步的：等监听器注册完再发事件，否则 meta 在 on() 之前被丢进虚空。 */
const waitListener = () => vi.waitFor(() => {
  if (!refs.listener) throw new Error('listener not registered yet');
});

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(merged);
}

describe('hostApiStream', () => {
  it('meta → data×2 → end：按 streamId 重组为完整字节流', async () => {
    const promise = hostApiStream('/api/evaluate/run', { method: 'POST', body: '{}' });
    expect(refs.invoke).toHaveBeenCalledWith('hostapi:stream', { path: '/api/evaluate/run', method: 'POST', body: '{}' });
    const enc = new TextEncoder();
    await waitListener();
    emit({ streamId: 's-1', kind: 'meta', status: 200, ok: true });
    const res = await promise;
    expect(res.status).toBe(200);
    emit({ streamId: 's-1', kind: 'data', chunk: enc.encode('event: verdict\n') });
    emit({ streamId: 's-1', kind: 'data', chunk: enc.encode('data: {}\n\n') });
    emit({ streamId: 's-1', kind: 'end' });
    expect(await readAll(res.body)).toBe('event: verdict\ndata: {}\n\n');
    expect(refs.unsubscribe).toHaveBeenCalled();
  });

  it('其他 streamId 的事件被忽略（多流并存不串台）', async () => {
    const promise = hostApiStream('/api/evaluate/run');
    await waitListener();
    emit({ streamId: 'other', kind: 'meta', status: 500, ok: false });
    emit({ streamId: 'other', kind: 'data', chunk: new Uint8Array([88]) });
    emit({ streamId: 's-1', kind: 'meta', status: 200, ok: true });
    const res = await promise;
    emit({ streamId: 's-1', kind: 'data', chunk: new Uint8Array([65]) });
    emit({ streamId: 's-1', kind: 'end' });
    expect(await readAll(res.body)).toBe('A');
  });

  it('meta 前出错 → promise 拒绝', async () => {
    const promise = hostApiStream('/api/evaluate/run');
    await waitListener();
    emit({ streamId: 's-1', kind: 'error', message: 'connect refused' });
    await expect(promise).rejects.toThrow('connect refused');
  });

  it('meta 后出错 → 流进入 error 态', async () => {
    const promise = hostApiStream('/api/evaluate/run');
    await waitListener();
    emit({ streamId: 's-1', kind: 'meta', status: 200, ok: true });
    const res = await promise;
    emit({ streamId: 's-1', kind: 'error', message: 'mid-stream boom' });
    await expect(readAll(res.body)).rejects.toThrow('mid-stream boom');
  });

  it('无 Electron IPC 环境 → 直接抛错（调用方走降级）', async () => {
    (window as unknown as { electron: unknown }).electron = undefined;
    await expect(hostApiStream('/api/evaluate/run')).rejects.toThrow('requires Electron IPC');
  });
});
