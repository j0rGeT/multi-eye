/**
 * 带代理的 HTTP 客户端。
 *
 * 为什么要专门做这一层，而不是直接用全局 fetch：
 *
 *  1. **Node 的全局 fetch 不读代理环境变量。** 它是 undici，默认直连，
 *     把 shell 里 `https_proxy=...` export 出去也完全没用，必须自己挂 agent。
 *
 *  2. **不能用「全局 fetch + npm undici 的 ProxyAgent」这个组合。**
 *     Node 自带一份 undici，npm 装的是另一份，两份的 Dispatcher 内部协议
 *     对不上，实测报 `InvalidArgumentError: invalid onRequestStart method`。
 *     必须让 fetch 和 agent 来自同一份 —— 所以这里统一用 npm undici 的 fetch，
 *     它和 Node 全局 fetch 本就是同一实现，行为一致。
 *
 *  3. **不是所有请求都该走代理。** 国内站点从境外出口过去要么超时要么被风控，
 *     所以按域名分流：国内直连、境外走代理（见 DOMESTIC_SUFFIXES）。
 *
 * 代理地址来自 config.fetchProxyUrl；置空则全部直连，调用方无感。
 */

import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { config } from "@/core/env";
import { shouldProxy } from "@/core/net/domestic";

/**
 * 建立代理隧道的最长等待。
 *
 * undici 默认 10 秒，对本地代理太紧：它得先自己连上目标站再回隧道，实测
 * 约 5% 的图片请求会卡在握手超时（`Connect Timeout Error ... timeout: 10000ms`），
 * 而同一个 URL 紧接着重试就成功。给足余量比让用户看到「下载失败」划算。
 */
const CONNECT_TIMEOUT_MS = 30_000;

let agent: Dispatcher | undefined;
let agentForUrl = "";

/*
  「哪些站点该直连」的判定搬到了 `core/net/domestic.ts` —— 因为 `core/env.ts`
  的 `ytdlpCommonArgs()` 也要用它，而 env.ts 被本模块 import，直接从这边引会成环。
  这里原样转出去，既有的 `from "@/core/fetch/agent"` 调用点一个都不用改。
*/
export { DOMESTIC_SUFFIXES, isDomesticHost, shouldProxy } from "@/core/net/domestic";

function urlText(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/** 取得（并缓存）当前配置对应的代理 agent；未配置代理时返回 undefined。 */
export function proxyAgent(): Dispatcher | undefined {
  const url = config.fetchProxyUrl.trim();
  if (!url) return undefined;

  // 地址变了就换一个 agent，避免配置热更新后继续走旧代理
  if (!agent || agentForUrl !== url) {
    void agent?.close().catch(() => {});
    agent = new ProxyAgent({ uri: url, connectTimeout: CONNECT_TIMEOUT_MS });
    agentForUrl = url;
  }
  return agent;
}

/**
 * 把网络层的错误换成能读的那种。
 *
 * undici 在连接层面出错时只抛一句 `TypeError: fetch failed`，真正的原因
 * （连接超时、DNS、TLS、代理拒绝）藏在 cause 里。不摊开的话，界面上、
 * 任务的 error 字段里就只剩这四个字，完全没法排查。
 */
export function networkErrorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const causes: string[] = [];
  let cause: unknown = err.cause;
  // cause 也可能自带 cause（如 "fetch failed" → ConnectTimeoutError）
  for (let depth = 0; cause && depth < 3; depth++) {
    if (!(cause instanceof Error)) {
      causes.push(String(cause));
      break;
    }
    causes.push(cause.message);
    cause = cause.cause;
  }
  return causes.length > 0 ? `${err.message}（${causes.join(" → ")}）` : err.message;
}

/**
 * 与全局 fetch 同签名，但会自动带上代理。
 *
 * 走 undici 自己的 fetch 而不是全局的，是为了让 fetch 与 ProxyAgent 出自
 * 同一份 undici（见文件头第 2 条）。
 */
export const httpFetch: typeof globalThis.fetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  // 国内站点直连，境外走代理 —— 见 DOMESTIC_SUFFIXES 上的实测记录
  const dispatcher = shouldProxy(urlText(input)) ? proxyAgent() : undefined;
  // undici 的 RequestInit 多一个 dispatcher 字段，而 lib.dom 的类型里没有，
  // 所以先构造对象再补字段，避免直接展开一个不兼容的类型。
  const merged: RequestInit & { dispatcher?: Dispatcher } = { ...(init ?? {}) };
  if (dispatcher) merged.dispatcher = dispatcher;
  try {
    const res = await undiciFetch(input as never, merged as never);
    return res as unknown as Response;
  } catch (err) {
    // abort 原样抛出：调用方靠 signal.aborted 和错误名区分「用户取消」和
    // 「网络坏了」，包一层会把那个信号盖掉
    if (isAbort(err)) throw err;
    throw new Error(networkErrorText(err), { cause: err });
  }
}) as typeof globalThis.fetch;

/**
 * 直连版：与 httpFetch 同签名，但**无条件不走代理**。
 *
 * httpFetch 已经会按域名分流，所以这里的存在意义是「我确定这个请求必须直连」：
 * LLM 端点（境内的 API）和 B站接口都属于这类。它不依赖 DOMESTIC_SUFFIXES
 * 那份清单，因此换一个国内的 LLM 服务商不会被漏掉。
 */
export const directFetch: typeof globalThis.fetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  try {
    return await globalThis.fetch(input, init);
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new Error(networkErrorText(err), { cause: err });
  }
}) as typeof globalThis.fetch;

/**
 * 把「调用方的取消」和「本次请求的超时」合成一个 signal。
 *
 * 用 AbortSignal.timeout 单独做不到这件事 —— 那个 signal 没法把外部的 abort
 * 接进来，于是「用户点了取消」会一直等到超时才响应。用完必须 release()，
 * 否则定时器会一直挂着。
 */
export function withTimeout(
  signal: AbortSignal | undefined,
  ms: number,
  what: string,
): { signal: AbortSignal; release: () => void } {
  const ac = new AbortController();
  const onAbort = () => ac.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => ac.abort(new Error(`${what}超时（${Math.round(ms / 1000)} 秒）`)),
    ms,
  );
  return {
    signal: ac.signal,
    release: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || (err as { code?: string }).code === "ABORT_ERR")
  );
}

/** 进程退出时释放连接池，避免 dev 热重载反复堆积 socket。 */
export async function closeAgent(): Promise<void> {
  await agent?.close().catch(() => {});
  agent = undefined;
  agentForUrl = "";
}
