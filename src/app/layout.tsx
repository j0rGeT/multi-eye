import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "muti-eye — 主题资源拓扑",
  description: "跨站点搜集资料，生成知识拓扑，导出 Markdown",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
