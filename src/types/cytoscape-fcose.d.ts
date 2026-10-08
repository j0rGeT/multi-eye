/**
 * cytoscape-fcose 是纯 JS 包，且没有 @types 发布。
 *
 * 这里只声明到「够用」为止：它是一个 Cytoscape 扩展，调用方唯一要做的就是
 * 把它交给 cytoscape.use()。布局参数的类型在下面用 LayoutOptions 处理，
 * 不在这里逐项复刻 —— fcose 的参数集比 Cytoscape 的 BaseLayoutOptions 宽，
 * 复刻一遍只会变成一份需要跟着上游维护的抄本。
 */
declare module "cytoscape-fcose" {
  import type cytoscape from "cytoscape";

  const extension: cytoscape.Ext;
  export default extension;
}
