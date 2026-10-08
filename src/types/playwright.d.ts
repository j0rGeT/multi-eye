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
  }

  export interface Page {
    goto(
      url: string,
      options?: { waitUntil?: string; timeout?: number },
    ): Promise<unknown>;
    waitForLoadState(state: string, options?: { timeout?: number }): Promise<void>;
    $(selector: string): Promise<ElementHandle | null>;
    content(): Promise<string>;
    close(): Promise<void>;
  }

  export interface BrowserContext {
    route(url: string, handler: (route: Route) => unknown): Promise<void>;
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }

  export interface Browser {
    newContext(options?: {
      userAgent?: string;
      locale?: string;
      viewport?: { width: number; height: number };
    }): Promise<BrowserContext>;
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
