/**
 * 单篇资料的 Markdown 渲染。
 *
 * ── 为什么要单独拎出来 ──
 *
 * 这段逻辑原先长在 `download/kinds.ts` 的 `writeArticle` 里，是下载队列的私有
 * 实现。P11 加了「打包下载 ZIP」之后，同一种文件有了**两个出口**：落盘的
 * `assets/<stem>.md`，和包里的 `正文/<stem>.md`。两边各写一份，迟早会在某个
 * 字段上悄悄分叉 —— 用户会发现「下载下来的」和「包里的」对不上。
 *
 * 所以只有这一个定义，下载队列和打包路由都调它。
 *
 * ── 为什么前面要加一段 frontmatter ──
 *
 * 这份文件脱离本工具之后仍然要能用：半年后打开它，得知道它是从哪来的、
 * 什么时候抓的、原文什么样。字段名沿用 YAML 惯例，被 Obsidian / Hugo /
 * Jekyll 直接认。
 */

import type { Document } from "@/core/types";
import { siteLabel } from "@/core/search/sites";

export function renderDocMarkdown(doc: Document): string {
  const body = doc.markdown?.trim() || doc.text;
  const meta = [
    "---",
    `title: ${JSON.stringify(doc.title)}`,
    `source: ${doc.url}`,
    `site: ${siteLabel(doc.site)}`,
    ...(doc.author ? [`author: ${JSON.stringify(doc.author)}`] : []),
    ...(doc.publishedAt ? [`published: ${JSON.stringify(doc.publishedAt)}`] : []),
    `fetched: ${doc.fetchedAt}`,
    `words: ${doc.wordCount}`,
  ];
  /*
    `extractNote` 只在抓取有问题时出现。

    它的存在本身就是信息：一篇带 `extractNote` 的资料，正文可能是少的、
    是从别处降级来的。不加这个字段，半年后没人分得清「这篇就是短」和
    「这篇当时没抓全」。
  */
  if (doc.error) meta.push(`extractNote: ${JSON.stringify(doc.error)}`);
  meta.push("---");

  return `${meta.join("\n")}\n\n# ${doc.title}\n\n${body}\n`;
}

/**
 * 视频字幕存成的纯文本。
 *
 * 不用 Markdown：字幕是逐句的口语，套上标题层级和加粗只会让它更难读，
 * 而它的用途是「对着视频看」或「丢给别的工具」，前缀几行 `#` 说明来路就够了。
 */
export function renderDocTranscript(doc: Document): string {
  return (
    `# ${doc.title}\n` +
    `# 来源：${doc.url}\n` +
    `# 抓取：${doc.fetchedAt}（${doc.extractMethod}）\n\n` +
    doc.text
  );
}
