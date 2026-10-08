import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
