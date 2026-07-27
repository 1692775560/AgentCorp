/**
 * electron/api/routes/evaluate.ts
 * 评估裁判 Host API 代理（T07）。
 *
 * 路由：POST /api/evaluate/run
 * 行为：读取请求体（JudgeRunInput），服务端转发至 modelServiceUrl 的
 *       /api/evaluate-run（MiniCPM-o 模型服务），将其返回的 SSE 事件流
 *       原样流式转发回 renderer。
 *
 * 鉴权：沿用 server.ts 的统一 isAuthorizedHostApiRequest（x-clawx-host-session）。
 * 模型服务不可达 / 非 200 时，返回 503 / 对应状态码（renderer 侧 judgeClient 会回退 Mock）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendJson } from '../route-utils';
import type { HostApiContext } from '../context';

interface EvaluateRunBody {
  agentId: string;
  agentName?: string;
  persona?: string;
  task?: { title?: string; description?: string; weight?: number };
  transcript?: string;
  usage?: unknown[];
  preference?: unknown;
}

export async function handleEvaluateRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname !== '/api/evaluate/run' || req.method !== 'POST') {
    return false;
  }

  const body = await parseJsonBody<EvaluateRunBody>(req);

  const upstreamUrl = `${ctx.modelServiceUrl}/api/evaluate-run`;
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    sendJson(res, 503, {
      success: false,
      error: `model-service unreachable at ${upstreamUrl}: ${String(err)}`,
    });
    return true;
  }

  if (!upstream.ok || !upstream.body) {
    sendJson(res, upstream.status || 502, {
      success: false,
      error: `model-service returned ${upstream.status}`,
    });
    return true;
  }

  // 流式转发 SSE
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    // 上游中断：尽力关闭，不影响已写入的事件
  } finally {
    res.end();
  }
  return true;
}
