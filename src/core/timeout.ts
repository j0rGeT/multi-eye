/**
 * 把「调用方的取消」和「本次请求的超时」合成一个 signal。
 *
 * 这个文件是**叶子模块**：一行 import 都没有。理由和 `kind.ts` / `relevance.ts`
 * 一样 —— `examples/e2e.mjs` 要直接引它做回归（Node 的类型擦除跑不了 `@/`
 * 别名，值导入会炸，`import type` 会被整条擦掉）。下面这个 bug 就是靠肉眼
 * 看不出来的那类，必须有断言钉住。
 *
 * ── 为什么不能直接用 `AbortSignal.timeout` ──
 *
 * 那个 signal 没法把外部的 abort 接进来，于是「用户点了取消」会一直等到超时
 * 才响应。所以要把两个来源合成一个。用完必须 `release()`，否则定时器会一直
 * 挂着（进程退出会被它拖住）。
 *
 * ── 修掉的 bug：传进来的 signal 已经 abort 时，截止时间被静默丢弃 ──
 *
 * 原来的写法只做一件事：给传进来的 signal 挂一个 `"abort"` 监听器。可是
 * **给一个已经 abort 的 signal 挂监听器，那个监听器永远不会触发** —— 事件在
 * 挂上去之前就已经发生了。于是返回的 signal 只受这里的 `ms` 兜底控制。
 *
 * 踩中的场景是「一个截止时间罩住多次调用」：
 *
 *     const deadline = AbortSignal.timeout(20_000);   // 罩住所有批次
 *     for (const batch of batches) {
 *       await chatJson(..., { signal: deadline });    // 每批一次调用
 *     }
 *
 * 第一批正常超时后，第二批拿到的 `deadline` 已经是 aborted 的。此时旧的实现
 * 把 20 秒的截止时间丢掉，换成 `chat()` 的兜底 300 秒 —— 而 `relevance-llm.ts`
 * 的注释明明写着「超时就放弃剩余的批次」。注释是对的，代码不是。
 *
 * 实测过一次：同一条 4 站点的搜索出现 900 秒级的等待，而端点和模型本身都是
 * 秒级（同一提示词直连端点 5.0 秒返回）。修法见下：入口就检查 `aborted`，
 * 立刻同态返回，不再假装还有 deadline。
 */
export function withTimeout(
  signal: AbortSignal | undefined,
  ms: number,
  what: string,
): { signal: AbortSignal; release: () => void } {
  const ac = new AbortController();

  /*
    入口同态：调用方给的 signal 已经 abort 了，那本次请求就该**立刻**失败。
    不这么做的话下面那个监听器挂上去也永远不会触发，调用方的截止时间等于没写。

    这不是「顺手加的防御」—— 它正是这个模块存在的理由。见文件头。
  */
  if (signal?.aborted) {
    ac.abort(signal.reason);
    return { signal: ac.signal, release: () => {} };
  }

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
