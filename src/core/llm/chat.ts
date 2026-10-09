/**
 * 共享的 LLM 客户端（OpenAI 协议）。
 *
 * 这一段逻辑原本私有在 `graph/llm.ts` 里。查询分析与相关性判定都要用它 ——
 * 再抄一份就是第二份真相，而这类代码的分裂症状极其隐蔽：改了一处提示词或
 * 校验逻辑，另一条路径「偶尔就不听话」。
 *
 * ── 三条从实测里来的约束，逐字搬过来 ──
 *
 *  1. **它是推理模型。** 返回里 content 之外还有 reasoning_content，思维链与
 *     正文共享 max_tokens。额度给小了（试过 200）思维链会把额度吃光，content
 *     是空字符串、finish_reason 是 "length" —— 看起来像模型哑了。所以这一
 *     情况必须单独翻译成一句人话，而不是笼统的「模型返回了空内容」。
 *
 *  2. **json_object 保证的是语法不是形状。** 少一个数组、把 weight 写成字符串
 *     都会被放行。所以 `chatJson` 有一轮**返修**：把模型自己写的那份 JSON
 *     连同校验错误发回去让它改。返修一次的成功率高得不成比例，而失败的代价
 *     只是再一次调用。
 *
 *  3. **不走代理。** `directFetch` 而不是 `httpFetch`：LLM 端点（DeepSeek）
 *     在境内，抓取代理是为墙外站点准备的，把 API 请求塞进境外出口只会更慢、
 *     更容易被判成异常流量。两件事的网络需求正好相反，理由详见
 *     `env.ts` 的 `describeLlmChain`。
 *
 * ── 顺带补上 token 记账 ──
 *
 * 此前 `chat()` 只读 `choices[0]`，把 API 返回的 `usage` 整个丢掉了。构图一次
 * 只调一次，无所谓；但引入查询分析与相关性判定之后，一次搜索会有 2~4 次调用，
 * 「这次搜索花了多少」就成了用户该看得到的数字。用 `llmUsage()` 取累计快照、
 * 调用前后做差即可，不必把计数一路穿参数传下去。
 */

import type { ZodType } from "zod";
import { config } from "@/core/env";
import { directFetch, withTimeout } from "@/core/fetch/agent";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * API 回报的 token 用量。端点没给就是 `undefined` —— 不填 0，
 * 因为「用量为零」和「这个端点不报用量」是两件事。
 */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  content: string;
  usage?: ChatUsage;
}

export interface ChatOpts {
  signal?: AbortSignal;
  /**
   * 覆盖默认的 max_tokens。
   *
   * 查询规划这类「输出就几百字」的任务犯不上用构图那份 32768 —— 额度越大，
   * 模型胡思乱想的空间也越大，而且真被截断时的等待更久。
   */
  maxTokens?: number;
  /** 覆盖默认的超时（`LLM_TIMEOUT_MS`）。短任务用短超时，别让一次卡住拖垮搜索。 */
  timeoutMs?: number;
}

// ─────────────────────────── 用量记账 ───────────────────────────

export interface LlmUsageSnapshot {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

const usageTotal: LlmUsageSnapshot = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
};

/**
 * 进程级的累计用量快照。
 *
 * 刻意返回**副本**：调用方要拿它和稍后的快照做差（「这次搜索花了多少」），
 * 返回内部对象的话，差值会在下一次调用时被悄悄改掉。
 */
export function llmUsage(): LlmUsageSnapshot {
  return { ...usageTotal };
}

// ─────────────────────────── 调用 ───────────────────────────

/** 发一次 /chat/completions，把正文取回来。 */
export async function chat(
  messages: ChatMessage[],
  opts: ChatOpts = {},
): Promise<ChatResult> {
  const maxTokens = opts.maxTokens ?? config.llmMaxTokens;
  const timeoutMs = opts.timeoutMs ?? config.llmTimeoutMs;
  const { signal: s, release } = withTimeout(opts.signal, timeoutMs, "LLM 请求");

  try {
    const res = await directFetch(`${config.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: s,
    });

    const body = await res.text();
    if (!res.ok) {
      // 把状态码和响应体一起带出去：上层要靠 401/429 分类降级原因，
      // 而「HTTP 400」这四个字对用户没有任何信息量。
      throw new Error(
        `HTTP ${res.status}：${body.replace(/\s+/g, " ").slice(0, 300)}`,
      );
    }

    const data = JSON.parse(body) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";

    usageTotal.calls += 1;
    const usage = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
        }
      : undefined;
    if (usage) {
      usageTotal.promptTokens += usage.promptTokens;
      usageTotal.completionTokens += usage.completionTokens;
    }

    if (!content.trim()) {
      // 实测：额度被思维链吃光时就是这个样子，finish_reason 是 "length"
      if (choice?.finish_reason === "length") {
        throw new Error(
          `输出被 max_tokens=${maxTokens} 截断，正文为空。` +
            "该模型先输出思维链且与正文共享额度，把 LLM_MAX_TOKENS 调大即可。",
        );
      }
      throw new Error("模型返回了空内容");
    }

    return { content, usage };
  } finally {
    release();
  }
}

/**
 * 有些兼容端点会无视 response_format 把 JSON 包在 ```json 里。
 * 与其把这一条写进「已知问题」，不如剥掉三个反引号。
 */
export function stripFence(s: string): string {
  const t = s.trim();
  if (!t.startsWith("```")) return t;
  return t.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
}

/**
 * 发一次、校验，失败就带着模型自己那份 JSON 与校验错误**返修一次**。
 *
 * 第二轮不是「重试」而是「返修」：把校验失败的原话连同模型自己写的那份 JSON
 * 一起发回去，让它改。JSON mode 只保证括号对得上，保证不了
 * relations 里引用的实体都存在、weight 是数字。
 *
 * 两次都不合格就抛错，由调用方决定降级到哪条路 —— 这里的职责边界是
 * 「要么给你一份形状正确的数据，要么明确地失败」，不包括「猜一个默认值」。
 */
export async function chatJson<T>(
  schema: ZodType<T>,
  messages: ChatMessage[],
  opts: ChatOpts = {},
): Promise<T> {
  const convo = [...messages];
  let why = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const { content } = await chat(convo, opts);
    const outcome = validate(schema, content);
    if (outcome.ok) return outcome.data;

    why = outcome.why;
    if (attempt === 0) {
      convo.push({ role: "assistant", content });
      convo.push({
        role: "user",
        content:
          `上面的 JSON 不符合要求的形状：${why}\n` +
          "请只输出修正后的 JSON 对象本身，不要解释、不要 Markdown 代码块。",
      });
    }
  }

  throw new Error(`模型返回的 JSON 不符合结构：${why}`);
}

type Validated<T> = { ok: true; data: T } | { ok: false; why: string };

function validate<T>(schema: ZodType<T>, content: string): Validated<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFence(content));
  } catch (err) {
    return {
      ok: false,
      why:
        `不是合法 JSON（${err instanceof Error ? err.message : String(err)}）；` +
        `开头是 ${content.slice(0, 80)}`,
    };
  }

  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };

  // zod 的完整 issue 列表太长，进不了提示词；头三条足够定位问题
  const why = parsed.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`)
    .join("；");
  return { ok: false, why };
}
