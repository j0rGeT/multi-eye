/**
 * SSE 的客户端读取器。
 *
 * 为什么不用 EventSource：它只支持 GET，而搜索和抓取都需要带请求体
 * （主题、站点列表、会话 id）。所以这里用 fetch 手动读流并解析 SSE 帧。
 * 下载进度那条流确实是 GET，但为了两条流共用同一套解析（尤其是错误响应
 * 的读法），也一并走 fetch。
 *
 * SSE 的帧格式是以空行分隔的记录，每行 `field: value`。我们只关心 data 行；
 * 服务端每 15 秒发的 `: ping` 心跳是注释行，会被自然跳过。
 */

export async function postSse<T>(
  url: string,
  body: unknown,
  onEvent: (event: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  await readSse(res, onEvent);
}

/** GET 版的 SSE 读取。用于下载进度：轮询参数走 query string 就够了。 */
export async function getSse<T>(
  url: string,
  onEvent: (event: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { signal });
  await readSse(res, onEvent);
}

async function readSse<T>(
  res: Response,
  onEvent: (event: T) => void,
): Promise<void> {
  if (!res.ok) {
    // 路由在参数错误时回 JSON 而不是 SSE，这里要把那条错误读出来，
    // 否则用户只会看到一个没有信息量的 "HTTP 400"
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) detail = j.error;
    } catch {
      // 响应不是 JSON，保留状态码
    }
    throw new Error(detail);
  }

  if (!res.body) throw new Error("响应没有流式内容");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue; // 心跳与注释行
        const payload = line.slice(6);
        try {
          onEvent(JSON.parse(payload) as T);
        } catch {
          // 半截帧或非 JSON：丢掉即可，不要让一条坏记录中断整个流
        }
      }
    }
  }
}
