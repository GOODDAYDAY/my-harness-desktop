// Electron main 入口 —— 调 assemble + 开窗 + app 生命周期。
// 共享组装(stores/ctx/gateway/handlers/起服务器)在 assemble.ts,此处只做 Electron 宿主特有的事。
import { app, BrowserWindow, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assemble } from "./assemble";
import { createElectronHost } from "../host/electron-host";

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
const host = createElectronHost(() => mainWindow);
// rendererDir 在入口算(而非 assemble 内):__dirname 恒为 out/main(入口非 chunk),
// ../renderer 在 dev/打包态都指向 out/renderer;打包态在 app.asar 内,fs 透明读。
const assembled = assemble(host, { isPackaged: app.isPackaged, rendererDir: resolve(__dirname, "../renderer") });

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    // 无边框窗口(renderer 顶栏 -webkit-app-region: drag):mac 红绿灯内嵌自定义标题栏;
    // win/linux 无原生按钮,标题栏自绘 min/max/close(经 window:* channel)。
    ...(process.platform === "darwin"
      // trafficLightPosition 定位的是按钮容器原点,容器带 2px 内衬,实测圆心 = y + 8;
      // 垂直居中:y = 标题栏 40px / 2 − 8 = 12(像素截图实测验证,勿按 y+6 目测微调)
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 12 } }
      : { frame: false as const, autoHideMenuBar: true }),
    backgroundColor: "#0b0b0c",
    icon: resolve(__dirname, "../../assets/icons/icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 拖拽/粘贴文件的绝对路径解析(webUtils.getPathForFile),见 preload.ts。
      preload: resolve(__dirname, "preload.js"),
    },
  });
  mainWindow = win;
  // 窗口最大化状态 → 广播 push(§19.4),renderer 据此切 最大化/还原 图标。
  host.window.onMaximizedChanged((m) => assembled.gateway.broadcast("window:maximizedChanged", m));

  // 外部链接一律交给系统,不在应用内开新窗口/导航(桌面壳标准做法):
  // window.open / target=_blank 经 setWindowOpenHandler 拦截——http(s) 用默认浏览器,
  // file: 本地文件用系统关联程序;renderer 内跨源导航(链接点击)经 will-navigate 拦截,
  // 防应用自身页面被替换成外部页面。markdown 等渲染的 <a target="_blank"> 由此统一生效。
  win.webContents.setWindowOpenHandler(({ url }) => {
    void (url.startsWith("file:") ? shell.openPath(url) : shell.openExternal(url));
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const current = win.webContents.getURL();
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === new URL(current).origin;
    } catch { /* 解析失败的导航一律视为外部 */ }
    if (sameOrigin) return; // 应用自身页面内导航(hash/刷新)放行
    event.preventDefault();
    void (url.startsWith("file:") ? shell.openPath(url) : shell.openExternal(url));
  });

  // web 服务化(§4.4):本地窗口加载 http://127.0.0.1:PORT + local token;dev 用 vite URL。
  const base = process.env["ELECTRON_RENDERER_URL"] ?? `http://127.0.0.1:${assembled.port}/`;
  void win.loadURL(`${base}${base.includes("?") ? "&" : "?"}lt=${assembled.localToken}`);

  win.on("ready-to-show", () => win.show());
}

app.setName("My Harness Desktop");
// Windows toast 硬门槛:应用必须有稳定 AUMID(打包版由 electron-builder NSIS 按 appId 写好,
// dev 态必须手动补,否则系统通知不显示或显示成 Electron)。mac/linux 是 no-op。
app.setAppUserModelId("works.earendil.my-harness-desktop");

app.whenReady().then(() => {
  // dock 图标尽早设置:createWindow 使进程进入 dock,若 bundle 图标未生效
  // (LaunchServices 缓存陈旧),此处晚于 createWindow 会闪现默认图标。
  // bundle 修复见 assets/scripts/patch-electron.cjs(改 icns 后 touch + lsregister)。
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(resolve(__dirname, "../../assets/icons/icon.png"));
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 应用退出:停所有会话的 pi 进程(多会话多进程,兜底清理)。
// before-quit 是同步事件:preventDefault 阻断退出,等 stopAll(含 kill 链 stdin→SIGTERM→SIGKILL)
// 真正完成再 exit——否则子进程变孤儿(主进程已死,pi 被 init 收养不退出)。
app.on("before-quit", (event) => {
  event.preventDefault();
  void assembled.sessionStore.stopAll().finally(() => app.exit());
});
