# examples · 全链路验证

两个脚本，都不依赖浏览器：

| 文件 | 作用 |
|---|---|
| `e2e.mjs` | 把一个主题从搜索走到下载，逐项断言，最后给出通过/降级/失败清单 |
| `show.mjs` | 读磁盘上的会话，把拓扑、抓取质量、报告用文本打出来 |

`e2e.mjs` 是**验证**（断言 + 退出码），`show.mjs` 是**观察**（不发请求，只看产物）。

## 为什么要做这个

这个项目里几乎所有失败都是**静默的**。

搜索层 SearXNG 挂了会降级到 Serper，抓取层 B 站被风控会退回搜索摘要，构图层
LLM 返回的 JSON 不合形状会自动降级回启发式，下载层单篇失败不会中断整批 ——
设计上「永远给你一个结果」，代价是「你拿到的不一定是你以为的那个」。

界面上的降级徽标能补一部分，但没人会每次手点五个按钮去核对。所以
`e2e.mjs` 把每一步的**降级证据**当成断言来查，而不是只看「有没有报错」。

## 用法

```bash
# 另开一个终端把服务起起来
pnpm dev
curl -s localhost:3000/api/health | jq '.healthy, .searchChain, .graphBuilder'

# 全链路（含 LLM 构图，约 2~4 分钟）
pnpm example

# 常用变体
node examples/e2e.mjs --verbose              # 打印每一条流式事件
node examples/e2e.mjs --no-llm               # 跳过 LLM（快 1 分钟）
node examples/e2e.mjs --query 登山杖 --sites bilibili,youtube
node examples/e2e.mjs --fetch-limit 20       # 多抓几篇
node examples/e2e.mjs --media                # 连视频本体一起下（慢、占磁盘）
node examples/e2e.mjs --clean                # 跑完删掉产物
```

产出的会话 id 会打印在最后，可以直接接着看：

```bash
pnpm example:graph  <sessionId>          # 拓扑：分簇、每簇 top 词、簇内边
pnpm example:docs   <sessionId>          # 逐篇抓取结果 + 降级原因
pnpm example:report <sessionId>          # 导出的 Markdown 前 60 行

node examples/show.mjs <sessionId> --mermaid --all     # 更多组合
node examples/show.mjs                                  # 不带 id 就列出最近的会话
```

## e2e 验了哪 8 步

| 步骤 | 断言的是 |
|---|---|
| 0 部署就绪 | 服务可达；`/api/health` 里每一项依赖的状态；搜索链路非空 |
| 1 搜索 | 结果数 > 0；**每个请求过的站点都有 provider 记录**；至少命中 2 个站点 |
| 2 抓取 | 逐篇回传；至少 1 篇拿到正文；**每次降级都写明了原因**；降级档位可观测；B 站是否走专用接口 |
| 3 会话 | 正文已落盘；`session.json` 真在磁盘上 |
| 4 构图·启发式 | 成功；`generatedBy=heuristic`；有节点/边/簇；**TF-IDF 前排无字段名污染** |
| 5 构图·LLM | 走的是 LLM 还是自动降级；**产出带谓词的边**；簇名可作章节标题；与启发式同一个 `GraphModel` 形状 |
| 6 导出 | Content-Type；RFC 5987 中文文件名；含 Mermaid/链接/章节；磁盘文件与响应一致 |
| 7 下载 | 任务建立；snapshot + 增量事件；进终态；**文件真的落在 `assets/` 下且非空** |
| 8 恢复 | 状态可从磁盘读回；已完成任务数稳定；`retry` 明确回答「有没有要重跑的」 |

三处加粗的断言是这里面最有价值的，因为它们覆盖的正是「看起来正常但其实已经
坏了」的情形：

- **每个站点都有 provider 记录** —— 只看总结果数的话，「B 站 0 条」和「全网
  40 条」都算通过，站点定向这条链路坏了也发现不了。
- **每次降级都有原因** —— 文档悄悄退化成搜索摘要却不留原因，是最难排查的一类
  问题。比例高低取决于这次搜到了什么（B 站大量视频没有 CC 字幕、知乎对游客
  一律 403），所以比例只报警告，**「没有原因」才判失败**。
- **文件真的落在磁盘上** —— 进度条走到 100% 而 `assets/` 里没有文件，是「异步
  下载」这个承诺最容易发生也最难发现的一种破产方式。

## 退出码与「降级」的区别

- **失败（红 ✗）**：产品行为不对，退出码 1
- **降级（黄 !）**：环境不具备，或站点侧的原因，退出码不变

「没配 `SERPER_API_KEY`」「没启用 Playwright」「知乎 403」「B 站视频没有字幕」
都会出现在降级清单里而不是失败清单里 —— 它们是**已知的、有意的**行为。想看
它们从哪来，`README.md` 的「已知限制」一节逐条写了原因。
