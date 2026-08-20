import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { proxyAwareFetch } from '../../utils/proxy-fetch';
import { getPort } from '../../utils/config';
import { HOST_API_SESSION_HEADER } from '../../api/route-utils';
import { logger } from '../../utils/logger';

type HostApiFetchRequest = {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

type HostApiStreamEvent =
  | { streamId: string; kind: 'meta'; status: number; ok: boolean }
  | { streamId: string; kind: 'data'; chunk: Uint8Array }
  | { streamId: string; kind: 'end' }
  | { streamId: string; kind: 'error'; message: string };

/** 流式事件统一走这一个静态通道（preload 的 on 白名单是静态列表），渲染进程按 streamId 分流。 */
const STREAM_EVENT_CHANNEL = 'hostapi:stream-event';

function buildAuthedRequest(request: HostApiFetchRequest, hostApiSessionToken: string) {
  const path = typeof request?.path === 'string' ? request.path : '';
  if (!path || !path.startsWith('/')) {
    throw new Error(`Invalid host API path: ${String(request?.path)}`);
  }
  const method = (request.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    ...(request.headers || {}),
    [HOST_API_SESSION_HEADER]: hostApiSessionToken,
  };
  let body: string | undefined;
  if (request.body !== undefined && request.body !== null) {
    if (typeof request.body === 'string') {
      body = request.body;
    } else {
      body = JSON.stringify(request.body);
      // Ensure Content-Type is set for requests with a body so the
      // server's anti-CSRF Content-Type gate does not reject them.
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }
  return { path, method, headers, body };
}

export function registerHostApiProxyHandlers(hostApiSessionToken: string): void {
  const hostApiPort = getPort('CLAWX_HOST_API');

  // NOTE: 会话 token 不再授予渲染进程（原 'hostapi:token' 通道已移除）——
  // 渲染进程一旦出现 XSS，持有 token 即获 Host API 全权限。
  // 所有请求一律由主进程代持 token 转发（hostapi:fetch / hostapi:stream）。

  ipcMain.handle('hostapi:fetch', async (_, request: HostApiFetchRequest) => {
    try {
      const { path, method, headers, body } = buildAuthedRequest(request, hostApiSessionToken);

      const response = await proxyAwareFetch(`http://127.0.0.1:${hostApiPort}${path}`, {
        method,
        headers,
        body,
      });

      const data: { status: number; ok: boolean; json?: unknown; text?: string } = {
        status: response.status,
        ok: response.ok,
      };

      if (response.status !== 204) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          data.json = await response.json().catch(() => undefined);
        } else {
          data.text = await response.text().catch(() => '');
        }
      }

      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });

  // SSE/流式端点（如 /api/evaluate/run）：主进程拉流、按块转发，
  // 渲染进程用 streamId 重组为 ReadableStream。token 全程不出主进程。
  ipcMain.handle('hostapi:stream', async (event, request: HostApiFetchRequest) => {
    const streamId = randomUUID();
    const sender = event.sender;
    const emit = (ev: HostApiStreamEvent) => {
      if (!sender.isDestroyed()) sender.send(STREAM_EVENT_CHANNEL, ev);
    };
    void (async () => {
      try {
        const { path, method, headers, body } = buildAuthedRequest(request, hostApiSessionToken);
        const response = await proxyAwareFetch(`http://127.0.0.1:${hostApiPort}${path}`, {
          method,
          headers,
          body,
        });
        emit({ streamId, kind: 'meta', status: response.status, ok: response.ok });
        if (response.body) {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) emit({ streamId, kind: 'data', chunk: value });
          }
        }
        emit({ streamId, kind: 'end' });
      } catch (error) {
        logger.warn('[hostapi:stream] proxy stream failed:', error);
        emit({ streamId, kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return { streamId };
  });
}
