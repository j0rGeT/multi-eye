/**
 * playwright 的最小类型声明。
 *
 * playwright 是**可选依赖**（数百 MB，只在一级降级命中时才用），所以没有装进
 * dependencies —— 但 fetch/playwright.ts 里用 `import type` 引用了它，没有类型
 * 就过不了 typecheck。
 *
 * 这里只声明实际用到的那一小部分 API。这样既能让类型检查通过，又不必把一个
 * 重量级包拖进依赖树。将来真的把 playwright 装进来时，删掉这个文件即可 ——
 * 官方类型会自然接管（本地声明优先级低于 node_modules 里的真实类型，
 * 但两者冲突时以本文件为准，所以届时务必删除）。
 */

declare module "playwright" {
  export interface Route {
    request(): { resourceType(): string };
    abort(errorCode?: string): Promise<void>;
    continue(overrides?: Record<string, unknown>): Promise<void>;
  }

  export interface ElementHandle {
    innerText(): Promise<string>;
    getAttribute(name: string): Promise<string | null>;
    /** 容器里还有没有「展开阅读全文」这类按钮 —— 判折叠要用。 */
    $$(selector: string): Promise<ElementHandle[]>;
    /** 展开按钮只能靠点。点不中（元素被遮挡/已消失）由调用方 `.catch(() => {})` 兜住。 */
    click(options?: { timeout?: number }): Promise<void>;
  }

  export interface Page {
    goto(
      url: string,
      options?: { waitUntil?: string; timeout?: number },
    ): Promise<unknown>;
    waitForLoadState(state: string, options?: { timeout?: number }): Promise<void>;
    $$(selector: string): Promise<ElementHandle[]>;
    $(selector: string): Promise<ElementHandle | null>;
    content(): Promise<string>;
    url(): string;
    close(): Promise<void>;
    /** 展开按钮点完之后，正文是异步写进 DOM 的，要等一下再读。 */
    waitForTimeout(ms: number): Promise<void>;
  }

  /** 与 playwright 官方 `Cookie` 对齐的那几个字段（见 core/auth/cookies.ts）。 */
  export interface CookieParam {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    /** Unix 秒。 */
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }

  export interface BrowserContext {
    route(url: string, handler: (route: Route) => unknown): Promise<void>;
    newPage(): Promise<Page>;
    /** 把登录态灌进上下文（见 fetch/playwright.ts 里为什么不用改请求头那条路）。 */
    addCookies(cookies: readonly CookieParam[]): Promise<void>;
    /** 注入在页面脚本前执行的初始化脚本（用于反爬特征抹除如 navigator.webdriver）。 */
    addInitScript(script: string | Function | { path?: string; content?: string }): Promise<void>;
    /** 读当前上下文里的 cookie。扫码登录靠它判「用户扫完了没有」。 */
    cookies(urls?: string | readonly string[]): Promise<CookieParam[]>;
    /** 已经打开的页面。扫码时知乎自己会跳转，要拿到的就是那个页面。 */
    pages(): Page[];
    close(): Promise<void>;
  }

  export interface Browser {
    newContext(options?: {
      userAgent?: string;
      locale?: string;
      viewport?: { width: number; height: number };
    }): Promise<BrowserContext>;
    /** 用户把窗口关掉时变 false —— 登录轮询靠它及时收手，不空等到超时。 */
    isConnected(): boolean;
    close(): Promise<void>;
  }

  export const chromium: {
    launch(options?: {
      headless?: boolean;
      args?: string[];
      proxy?: { server: string; username?: string; password?: string };
    }): Promise<Browser>;
  };
}
