import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  /**
   * 显式锁定应用根目录。
   *
   * 不写的话 Turbopack 会从项目目录向上找 lockfile 来推断工作区根，而用户主目录
   * 下恰好有一个无主的 pnpm-lock.yaml，于是每次构建都报
   * "ignored pnpm-lock.yaml ... outside the current Git repository"。
   * 那个文件与本项目无关，我们能控制的只有这一侧。
   */
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },

  // 这些包必须在 Node 里按原样 require，不能让打包器 bundle：
  //  - jieba-wasm  运行时用相对路径加载 .wasm 文件，打包后会找不到
  //  - jsdom       Readability 的 DOM 依赖，bundle 后会因动态 require 报错
  //  - playwright  可选依赖，缺失时需能优雅失败（lazy import）
  //  - undici      代理 agent 必须与 fetch 出自同一份实现，不能被 bundle
  serverExternalPackages: [
    "jieba-wasm",
    "jsdom",
    "@mozilla/readability",
    "playwright",
    "undici",
  ],
};

export default nextConfig;
