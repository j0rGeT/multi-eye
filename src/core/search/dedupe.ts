/**
 * 同源转载识别。
 *
 * ── 它解决什么问题 ──
 *
 * 这套系统的核心主张是「多个来源都提到了它，才更可能是关键资料」。但转载
 * 会把这个主张架空：一篇被 5 家媒体转载的文章，看起来和「被 5 个独立来源
 * 印证」一模一样，实际上只有 1 个信息源。
 *
 * 所以这里要回答的是：**这两篇是不是同一篇文章换了张皮**。
 *
 * ── 为什么用 simhash ──
 *
 * 转载的典型形态是**不同 URL、同一正文**（甚至同一正文加一段导语）。搜索
 * 阶段只有摘要，摘要太短、指纹不可靠，所以这一步只能放在**抓取之后**，
 * 拿全文来算。
 *
 * simhash 的好处是「相近的文本得到相近的指纹」—— 改几个词、换个标题、
 * 加一段编者按，汉明距离仍然很小。而它是个**确定性**算法，没有随机性，
 * 同样的输入永远得到同样的结果，不会出现「同一批资料两次跑出不同的合并」。
 *
 * ── 宁可漏判，不可误判 ──
 *
 * 阈值调得很保守（默认 3/64），并且**只标记不删除**。理由是这个方向上
 * 两种错误的代价完全不对称：
 *
 *   - 漏判：多算了一个来源，结果是「印证度虚高一点」—— 用户看到的是
 *     一个稍微乐观的排序
 *   - 误判：把两篇**不同**的文章合并了，用户会**永远看不到**其中一篇 ——
 *     而这套系统最忌讳的就是静默丢东西
 *
 * 所以：保守阈值 + 只标记 + 界面上可展开 + 报告里保留全部链接。
 */

import type { Document } from "@/core/types";
import { tokenize } from "@/core/graph/tokenize";

/** simhash 的位数。64 位在汉明距离上留出了足够的分辨率。 */
const BITS = 64n;

/**
 * 默认阈值：汉明距离 ≤ 8 判为同源。
 *
 * ── 这个数是**量出来的**，不是拍的 ──
 *
 * 拿 12 句的露营文章做基准，改造成不同程度的「转载」后测汉明距离
 * （实词数经 jieba 过滤后在 54~93 之间）：
 *
 *   | 用例 | 距离 |
 *   |---|---|
 *   | 完全相同 | 0 |
 *   | 加编者按、结尾加公众号（**这就是典型转载**） | 5 |
 *   | 替换 20% 的句子 | 14 |
 *   | 替换 50% 的句子 | 19 |
 *   | 替换 80% 的句子 | 19 |
 *   | 同领域但无关的文章 | 23 / 27 |
 *
 * 起初按直觉写的是 3 —— 实测发现**它会漏掉最典型的那种转载**（加个
 * 编者按就是 5）。而 5 和 14 之间是一道很宽的缝，把阈值放在缝里即可：
 * 8 比真实转载高 3，比最近的误判低 6。
 *
 * 之所以不放到 12（离两侧都更远）：这个方向上误判的代价更高 ——
 * 漏判只是印证度虚高一点，误判会让用户**永远看不到**其中一篇文章。
 * 宁可离真实转载近一点，也要离误判远一点。
 */
export const DEFAULT_MAX_DISTANCE = 8;

/**
 * 算正文的 simhash。
 *
 * 算法：把每个词的 hash 按位投票 —— 该位是 1 就 +1、是 0 就 -1，词频作为
 * 票重。最后每位取符号。这样「很多词都在这一位上是 1」的位最终为 1。
 *
 * 用词频而不是集合：一篇长文里「露营」出现 30 次和出现 1 次不该等价。
 */
export function simhash(words: string[]): bigint {
  const votes = new Array<number>(64).fill(0);

  // 词 → 频次。同一个词投多次，符合「高频词更能代表这篇文档」
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);

  for (const [word, n] of freq) {
    const h = fnv1a(word);
    for (let i = 0; i < 64; i++) {
      const bit = (h >> BigInt(i)) & 1n;
      votes[i] += bit === 1n ? n : -n;
    }
  }

  let out = 0n;
  for (let i = 0; i < 64; i++) {
    if (votes[i] > 0) out |= 1n << BigInt(i);
  }
  return out;
}

/**
 * FNV-1a 64 位。
 *
 * 刻意不用 `node:crypto` 的 sha1 —— 那个思路是「拿哈希当随机数」，而 simhash
 * 要求**同样的词在任何进程、任何机器上都得到同样的哈希**，否则两台机器算
 * 出的指纹不可比。FNV-1a 是纯算术、无依赖、完全确定的，正好合适。
 */
function fnv1a(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h;
}

/** 两个指纹的汉明距离（不同的位数）。 */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x !== 0n) {
    x &= x - 1n; // 抹掉最低位的 1
    n += 1;
  }
  return n;
}

/** 指纹转 16 位十六进制，便于落盘和比对。 */
export function fingerprintOf(h: bigint): string {
  return h.toString(16).padStart(16, "0");
}

export interface DuplicateGroup {
  /** 被判定为「同源」的文档 id，**不含**代表自己。 */
  duplicates: string[];
  /** 组里保留的那篇（抓取时间最早的一篇）。 */
  representative: string;
}

export interface DedupeResult {
  /** 文档 id → 它同源的那篇（代表）的 id。只含被判定为转载的文档。 */
  duplicateOf: Map<string, string>;
  /** 判定出的同源小组，供界面提示「这 N 篇是同一篇」。 */
  groups: DuplicateGroup[];
}

/**
 * 在已抓取的文档里找同源转载。
 *
 * 只处理正文够长的文档：摘要级（`snippet`）的文本太短，simhash 在短文本上
 * 的区分度很差，两篇不相干的短文很容易撞到阈值内。宁可对这它们不判 ——
 * 反正没正文的资料本来也不会进拓扑图（见 `quality.ts` 的 `bodyGrade`）。
 */
export async function findDuplicates(
  docs: Document[],
  opts: { maxDistance?: number; minWords?: number } = {},
): Promise<DedupeResult> {
  const maxDistance = opts.maxDistance ?? DEFAULT_MAX_DISTANCE;
  // 少于这个实词数就不参与判定：太短的文本上 simhash 不可靠
  const minWords = opts.minWords ?? 80;

  const printable = docs.filter(
    (d) => !d.error && d.wordCount >= minWords && d.text.trim().length > 0,
  );

  const prints = new Map<string, bigint>();
  for (const d of printable) {
    const tokens = await tokenize(d.text, { site: d.site });
    // 取词本身而不是 {word, tag} 列表
    const words = tokens.map((t) => t.word);
    // 分词后仍然太少的（比如整篇是代码），放弃判定
    if (words.length < minWords) continue;
    prints.set(d.id, simhash(words));
  }

  const ids = [...prints.keys()];
  const duplicateOf = new Map<string, string>();
  /** 代表 id → 它的成员。并查集风格：所有成员都指向组内代表。 */
  const membersOf = new Map<string, string[]>();

  /*
    按抓取时间排序后两两比较，**先到的当代表**。

    这个顺序是刻意固定的：不排序的话，谁是「代表」就取决于文档数组的顺序，
    而那个顺序来自一次并发的抓取 —— 同一个主题两次跑会选出不同的代表，
    报告里的「与《X》同源」于是指向不同的文章。测试会时绿时红，
    用户也会以为数据变了。
  */
  const ordered = printable
    .filter((d) => prints.has(d.id))
    .sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt) || a.id.localeCompare(b.id));

  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    const ha = prints.get(a.id)!;
    for (let j = i + 1; j < ordered.length; j++) {
      const b = ordered[j];
      // 已经被归进 a 这一组的不再重复比较
      if (duplicateOf.has(b.id)) continue;
      const hb = prints.get(b.id)!;
      if (hammingDistance(ha, hb) > maxDistance) continue;

      duplicateOf.set(b.id, a.id);
      const list = membersOf.get(a.id);
      if (list) list.push(b.id);
      else membersOf.set(a.id, [b.id]);
    }
  }

  const groups: DuplicateGroup[] = [...membersOf.entries()].map(
    ([representative, duplicates]) => ({ representative, duplicates }),
  );

  return { duplicateOf, groups };
}

/**
 * 把判定结果写回文档（**只标记，不删除**）。
 *
 * 返回一份新数组，原数组不动 —— 调用方可能还要拿原始数据做别的事，
 * 就地改会让「谁改的」变得难以追查。
 */
export function markDuplicates(
  docs: Document[],
  result: DedupeResult,
): Document[] {
  return docs.map((d) => {
    const rep = result.duplicateOf.get(d.id);
    return rep ? { ...d, duplicateOf: rep } : d;
  });
}

/**
 * 统计「独立出处」数。
 *
 * 这是 P8.4 里唯一一个会**改变数字**的地方：把同源转载折叠掉之后，
 * 一个被 5 家转载的稿子只算 1 个独立出处。报告与界面上的「多源印证」
 * 应该用这个数，而不是文档总数。
 */
export function independentSourceCount(docs: Document[]): number {
  const seen = new Set<string>();
  for (const d of docs) {
    // 有代表就归到代表头上，没有就是它自己
    seen.add(d.duplicateOf ?? d.id);
  }
  return seen.size;
}
