export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* 按客户端输入错误报告 */ }
  throw new HttpError(400, '请求体必须是 JSON 对象');
}

export function streamResponse(
  request: Request,
  contentType: string,
  stream: (signal: AbortSignal) => AsyncGenerator<Uint8Array<ArrayBuffer>>,
): Response {
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const source = stream(signal);
  return new Response(new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const next = await source.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      abort.abort(reason);
      await source.return(undefined);
    },
  }), {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
