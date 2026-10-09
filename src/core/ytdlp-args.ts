/**
 * yt-dlp 的**纯参数**构造。叶子模块：零 import，所以 `node script.mjs` 能
 * 直接引它做回归（与 `boilerplate.ts` / `net/domestic.ts` / `search/relevance.ts`
 * 同一套路）。
 *
 * 为什么不放在 `env.ts` 里：那边要读 `config`，而 `config` 依赖带 `@/` 别名的
 * 模块，Node 的类型剥离解析不了 —— 放进 env.ts 就等于这条断言只能靠肉眼。
 * 这个函数又不读任何配置，拆出来零成本。
 *
 * 带 `config` / 需要按目标站点分流代理的 `ytdlpCommonArgs` 仍在 `env.ts`。
 */

/**
 * **只给 YouTube 用**的额外参数：换一个播放器端点，绕过机器人墙。
 *
 * ── 为什么需要它 ──
 *
 * 我们的代理出口 IP 被 YouTube 标记了，默认 client 拿到的是一句
 * 「Sign in to confirm you're not a bot」—— 表现为一批视频全部
 * 「没有字幕」且抓取失败。这不是网络问题，是出口 IP 的信誉问题。
 *
 * 实测（2026-10，A/B 对照，同一个 `wjZofJX0v4M`）：
 *
 *   不带 --extractor-args → ERROR: Sign in to confirm you're not a bot
 *   带 android           → 下到 en.vtt 50,369 B + info.json（含 upload_date）
 *
 * `ios` 与 `web_embedded` 同样有效。
 *
 * ── 这不是认证，不越红线 ──
 *
 * 它换的是一个**公开的播放器客户端端点**，不带任何 cookie、不登录、不碰
 * 账号 —— 与「不逆向签名、不碰登录态」那条红线不冲突。抓的仍然是任何人都
 * 能看的公开视频。
 *
 * ── 必须作用域化 ──
 *
 * `--extractor-args` 的命名空间是 `youtube:`。实测把它传给 B 站目标时
 * yt-dlp 会忽略、B 站照常解析出标题 —— 但「靠它自己忽略」不该被依赖：
 * 三个调用点里，媒体下载那条路**主力就是 B 站**，万一将来 yt-dlp 改成对
 * 未知命名空间报错，废掉的是整条 B 站下载链，而且只在真跑时才暴露。
 * 所以下载链显式用 `isYoutubeUrl` 判一下（见 `download/kinds.ts`）。
 */
export function ytdlpYoutubeArgs(): string[] {
  return ["--extractor-args", "youtube:player_client=android"];
}
