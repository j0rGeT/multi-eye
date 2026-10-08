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
 * 代理地址来自 config.fetchProxyUrl；置空则自动退回直连，调用方无感。
 */

import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { config } from "@/core/env";

let agent: Dispatcher | undefined;
let agentForUrl = "";

/** 取得（并缓存）当前配置对应的代理 agent；未配置代理时返回 undefined。 */
export function proxyAgent(): Dispatcher | undefined {
  const url = config.fetchProxyUrl.trim();
  if (!url) return undefined;

  // 地址变了就换一个 agent，避免配置热更新后继续走旧代理
  if (!agent || agentForUrl !== url) {
    void agent?.close().catch(() => {});
    agent = new ProxyAgent(url);
    agentForUrl = url;
  }
  return agent;
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
  const dispatcher = proxyAgent();
  // undici 的 RequestInit 多一个 dispatcher 字段，而 lib.dom 的类型里没有，
  // 所以先构造对象再补字段，避免直接展开一个不兼容的类型。
  const merged: RequestInit & { dispatcher?: Dispatcher } = { ...(init ?? {}) };
  if (dispatcher) merged.dispatcher = dispatcher;
  const res = await undiciFetch(input as never, merged as never);
  return res as unknown as Response;
}) as typeof globalThis.fetch;

/** 进程退出时释放连接池，避免 dev 热重载反复堆积 socket。 */
export async function closeAgent(): Promise<void> {
  await agent?.close().catch(() => {});
  agent = undefined;
  agentForUrl = "";
}
