/**
 * 数据目录 —— **只有这一处**决定东西存在哪儿。
 *
 * 之前 `data/` 是写死在 `core/store.ts` 里的一句 `process.cwd()/data`。现在
 * 多了一个使用方（登录态 cookie 也要落盘），再抄一份就有两个真相了：一个
 * 改了另一个没改，症状是「会话在 A 目录、登录态在 B 目录」这种查不出原因的事。
 *
 * 零 import 的叶子模块，所以 `examples/e2e.mjs` 能直接引。
 *
 * ── 电子版（P9.3）要改的就是这一个文件 ──
 *
 * 打包成 .app 之后 cwd 在只读的 bundle 里，必须换成 userData：
 *
 *     process.env.MUTI_EYE_DATA_DIR ?? path.join(process.cwd(), "data")
 *
 * 现在还不加这一句，因为那会引入一个「环境变量在模块加载时读一次」的时机
 * 问题，而当前没有任何使用方需要它。留这一条注释是为了下次改的时候不用重新
 * 找一遍 ── 下游（sessions / auth）全部从这里派生，没有任何调用点要动。
 */

import path from "node:path";

export const DATA_DIR = path.join(process.cwd(), "data");

export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

/** 登录态。**这个目录里的东西是本机凭证，绝不允许进仓库**（见 .gitignore）。 */
export const AUTH_DIR = path.join(DATA_DIR, "auth");
