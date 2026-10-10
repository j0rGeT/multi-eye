import { app, BrowserWindow, shell } from "electron";
import http from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.MUTIEYE_PORT ?? 3173);
const externalUrl = process.env.MUTIEYE_URL?.trim();

let server;
let nextServer;
let mainWindow;

/**
 * 桌面壳只负责两件事：起一个本地 Next 服务、打开一个隔离的窗口。
 *
 * 服务跑在 Electron 自己的 Node 运行时里，不依赖用户额外安装 Node；
 * `MUTIEYE_URL` 则留给已经起好开发服务器的场景，方便热更新调试。
 */
async function startServer() {
  if (externalUrl) return externalUrl;

  nextServer = next({
    dev:
      process.env.MUTIEYE_DEV === "1" ||
      !existsSync(path.join(rootDir, ".next", "BUILD_ID")),
    dir: rootDir,
    hostname: "127.0.0.1",
  });
  await nextServer.prepare();

  const handler = nextServer.getRequestHandler();
  server = http.createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return `http://127.0.0.1:${port}`;
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return;
    } catch {
      // 首次编译/启动可能还在进行，继续轮询。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`本地服务启动超时：${url}`);
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: "#0d1117",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });
  void mainWindow.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    /*
      打包后的 cwd 是只读资源目录，会话和登录态必须落到 userData。
      这个环境变量在 Next 加载应用模块之前设置，`core/paths.ts` 只会读一次。
    */
    process.env.MUTI_EYE_DATA_DIR ??= path.join(app.getPath("userData"), "data");

    try {
      const url = await startServer();
      await waitForServer(url);
      createWindow(url);
    } catch (error) {
      console.error(error);
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && mainWindow) {
      mainWindow.show();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    server?.close();
    void nextServer?.close();
  });
}
