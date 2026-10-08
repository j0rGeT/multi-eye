/**
 * Server-Sent Events 工具。
 *
 * 搜索和下载都需要「边跑边把进展推给前端」—— 用户不该为了等最慢的那个站点
 * 而盯着空白页面。SSE 比 WebSocket 简单得多，且浏览器端 EventSource 自带重连。
 */

const encoder = new TextEncoder();

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform 很关键：某些代理会缓冲并改写流，导致事件迟迟不达
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // 让 nginx 之类的反代不要缓冲
  "X-Accel-Buffering": "no",
} as const;

/**
 * 把一个「推事件」的回调包成 SSE Response。
 *
 * 心跳是必需的：长时间没有字节流动时，中间层会掐断连接。这里每 15 秒发一个
 * 注释行（以 ':' 开头，EventSource 会忽略），既保活又不干扰业务事件。
 */
export function sseResponse<T>(
  run: (emit: (event: T) => void) => Promise<void>,
  signal?: AbortSignal,
): Response {
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // 客户端已断开时 close 会抛，忽略即可
        }
      };

      const emit = (event: T) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          close();
        }
      }, 15_000);

      signal?.addEventListener("abort", close, { once: true });

      try {
        await run(emit);
      } catch (err) {
        emit({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        } as unknown as T);
      } finally {
        close();
      }
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
