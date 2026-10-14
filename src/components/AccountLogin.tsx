"use client";

/**
 * 站点登录态面板（知乎 / 小红书 / 后续站点共用）。
 *
 * ── 为什么要单独一个面板 ──
 *
 * 登录失败是这套流程里用户**唯一自己能解决**的一类失败（站点下线、反爬、
 * 格式不对，改配置都没用，这个只要扫一次码就好了）。所以它值得在搜索面板里
 * 占一个位置，而不是藏在某个设置页里。
 *
 * ── 界面上必须说清楚的三件事 ──
 *
 *  1. **浏览器窗口开在我们这台机器上**（服务端进程），不是网页里弹一个框。
 *     不说的话用户会盯着网页等一个二维码，而二维码在另一个窗口里。
 *  2. **cookie 存在本机 data/auth/**，不入库、不上传 —— 这是用户授权这个
 *     功能的前提，必须写在界面上，不能只写在 README 里。
 *  3. **不登录也能用**，只是那几篇只有搜索摘要。不能让人以为这是必须做的
 *     一步，否则「没登录」会被读成「配置不全」。
 *
 * 和 FeedPanel 一样自成一个组件、自己管自己的状态：登录态是**长期配置**，
 * 跟本次搜索无关，没必要进出 page.tsx 的会话状态。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { postSse } from "./postSse";

interface Account {
  site: string;
  displayName?: string;
  savedAt: string;
  cookieCount: number;
  expired: boolean;
}

interface StatusResponse {
  site: string;
  loggedIn: boolean;
  account: Account | null;
  hint: string;
}

interface LoginEvent {
  stage: "launching" | "waiting" | "saving" | "done" | "error";
  message: string;
  account?: Account;
  error?: string;
}

export interface AccountLoginProps {
  /** 与 `SiteKey` 同名，例如 "zhihu" / "xiaohongshu"。决定调哪个 API。 */
  site: "zhihu" | "xiaohongshu";
  /** 面板标题里的站点名，例如「知乎账号」。 */
  title: string;
  /** 为什么这个站点要登录 —— 一句给用户看的实情（各站不一样）。 */
  why: string;
  /** 点按钮时提示用什么扫。 */
  scanTarget: string;
}

export default function AccountLogin({ site, title, why, scanTarget }: AccountLoginProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  /** 服务端一步步推过来的那句话（「正在打开浏览器…」「请扫码…」）。 */
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
    轮询期间组件可能已经卸载。SSE 的读取是异步的，回来时往一个已经卸载的
    组件上 setState 会报警告 —— 用一个 ref 挡住，而不是把整个流程挪进
    useEffect（那会让「点一下开始登录」这件事变难读）。
  */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/auth/${site}`);
      const data = (await res.json()) as StatusResponse;
      if (alive.current) setStatus(data);
    } catch {
      // 读不到就当未登录 —— 这个面板出问题不该把搜索面板带崩
      if (alive.current) setStatus(null);
    }
  }, [site]);

  // 折叠时也要读一次：芯片上要显示「已登录 / 未登录」
  useEffect(() => {
    void load();
  }, [load]);

  const doLogin = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProgress("正在打开浏览器…");
    try {
      await postSse<LoginEvent>(`/api/auth/${site}`, {}, (ev) => {
        if (!alive.current) return;
        setProgress(ev.message);
        if (ev.stage === "error") setError(ev.error ?? ev.message);
      });
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) {
        setBusy(false);
        setProgress(null);
        await load();
      }
    }
  }, [load, site]);

  const doLogout = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await fetch(`/api/auth/${site}`, { method: "DELETE" });
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) {
        setBusy(false);
        await load();
      }
    }
  }, [load, site]);

  const account = status?.account ?? null;
  const loggedIn = status?.loggedIn ?? false;
  const expired = account?.expired ?? false;

  /*
    过期要排在「未登录」前面判：一个过期的登录态在抓取侧就是未登录
    （`isLoggedIn` 这么说），但界面上必须说成「已过期，重新扫码」而不是
    「未登录」—— 后者会让用户以为记录丢了，然后去怀疑是不是没保存成功。
  */
  const label = expired
    ? "登录已过期"
    : !loggedIn
      ? "未登录"
      : account?.displayName
        ? `已登录：${account.displayName}`
        : "已登录";

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--border-subtle)", paddingTop: 10 }}>
      <button
        className="badge"
        onClick={() => {
          if (!open) void load();
          setOpen((v) => !v);
        }}
        style={{
          cursor: "pointer",
          color: loggedIn && !expired ? "var(--accent)" : "var(--fg-dim)",
          borderColor: loggedIn && !expired ? "#1f6feb66" : "var(--border)",
          background: loggedIn && !expired ? "#1f6feb15" : "transparent",
        }}
        title={`${title}需要登录态；不登录也能用，只是那几篇只有搜索摘要`}
      >
        {title} {label} {open ? "▾" : "▸"}
      </button>

      {open && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <p className="dim" style={{ fontSize: 11, margin: 0, lineHeight: 1.6 }}>
            {why}
          </p>

          <p className="dim" style={{ fontSize: 11, margin: 0, lineHeight: 1.6 }}>
            点下面的按钮会<strong>在这台机器上打开一个浏览器窗口</strong>（不是网页里弹框），
            用{scanTarget}扫码即可。cookie 只写入本机 <code>data/auth/</code>，
            <strong>不入库、不上传</strong>，随时可以用「退出登录」删掉。
            本项目不逆向该站点的签名算法，只是带上你自己登录后本来就有的 cookie。
          </p>

          {progress && (
            <p style={{ fontSize: 11, margin: 0, color: "var(--accent)" }}>{progress}</p>
          )}
          {error && (
            <p style={{ fontSize: 11, margin: 0, color: "var(--warn, #d29922)" }}>⚠ {error}</p>
          )}

          {account && (
            <p className="dim" style={{ fontSize: 11, margin: 0 }}>
              {account.displayName ? `${account.displayName} · ` : ""}
              保存于 {formatTime(account.savedAt)} · {account.cookieCount} 条 cookie
              {expired ? " · 已过期，重新扫码即可" : ""}
            </p>
          )}

          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn" disabled={busy} onClick={() => void doLogin()} style={{ fontSize: 11 }}>
              {busy ? "等待扫码…" : account ? "重新扫码登录" : `扫码登录${title.replace("账号", "")}`}
            </button>
            {/* 条件是 account 而不是 loggedIn：过期的也得能删掉 */}
            {account && (
              <button
                className="btn"
                disabled={busy}
                onClick={() => void doLogout()}
                title={`删掉本机保存的${title} cookie`}
                style={{ fontSize: 11 }}
              >
                退出登录
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
