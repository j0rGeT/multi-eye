/**
 * 并发闸与退避重试。
 *
 * 为什么需要：一次搜索要按站点扇出（知乎/小红书/YouTube/全网…），每个站点又要
 * 在 fallback 链上试多个 provider。不加限制的话瞬间几十个请求打向自建 SearXNG，
 * 而 SearXNG 自己还要向上游引擎发请求 —— 结果就是被上游限流甚至封禁。
 */

import pLimit from "p-limit";
import pRetry, { AbortError } from "p-retry";

/** 按 key 维护独立的并发闸。不同 provider/域之间互不挤占。 */
const limiters = new Map<string, ReturnType<typeof pLimit>>();

export function limiter(key: string, concurrency: number) {
  let l = limiters.get(key);
  if (!l) {
    l = pLimit(concurrency);
    limiters.set(key, l);
  }
  return l;
}

/** 判断错误是否值得重试。鉴权和格式错误重试多少次都一样。 */
export function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/HTTP 4(0[13]|04|22)/.test(msg)) return false; // 401/403/404/422
  if (/401|403|404|422/.test(msg) && /鉴权|无效|未配置/.test(msg)) return false;
  // YouTube 的机器人验证。官方解法是传 cookies，而本项目明确不碰登录态，
  // 所以这对我们是永久性失败 —— 重试只会白等三次 90 秒超时。
  if (/Sign in to confirm|not a bot/i.test(msg)) return false;
  // 其余（网络抖动、429、5xx、超时）都值得重试
  return true;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  return pRetry(
    async () => {
      try {
        return await fn();
      } catch (err) {
        // 不可重试的错误直接放弃，否则会白白等满退避时间
        if (!isRetryable(err)) {
          throw new AbortError(err instanceof Error ? err : new Error(String(err)));
        }
        throw err;
      }
    },
    {
      retries: attempts - 1,
      minTimeout: 500,
      maxTimeout: 4_000,
      factor: 2,
      // 稳定抖动，避免多个并发请求同时重试造成二次冲击
      randomize: true,
    },
  );
}

/** 把数组切成固定大小的块，用于批量处理（如分批送 LLM）。 */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
