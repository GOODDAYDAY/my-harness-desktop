import { IPC } from "@my-harness-desktop/shared";
// Electron main 入口 —— 调 assemble + 开窗 + app 生命周期。
// 共享组装(stores/ctx/gateway/handlers/起服务器)在 assemble.ts,此处只做 Electron 宿主特有的事。
import { app, BrowserWindow, dialog, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assemble, type Assembled } from "./assemble";
import { createElectronHost } from "../host/electron-host";
import { windowVisibilityPolicy } from "./window-visibility";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 窗口可见性(§5.6 测试静默纪律):MHD_WINDOW=hidden ⇒ 永不 show、不抢焦点、不弹系统通知。
// 测试脚本(scripts/demo/lib/quiet-env.mjs)默认注入 hidden;人工观察时 MHD_WINDOW=shown。
const visibility = windowVisibilityPolicy(process.env);

let mainWindow: BrowserWindow | null = null;
const host = createElectronHost(() => mainWindow, { nativeAlerts: visibility.nativeAlerts });
// `assemble` 是 async（启动编排步骤化之后必然如此，理由见 assemble.ts 文件头），所以本入口
// 在 `whenReady` 里 await 它，产物存进这个模块级变量供 createWindow / before-quit 使用。
// 启动失败时它保持 null —— before-quit 必须容忍（见文件末尾）。
let assembled: Assembled | null = null;

function createWindow(a: Assembled): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    // 静默态:窗口不可聚焦 + 不进任务栏 —— 即便将来被 show 也不夺键盘焦点。
    ...(visibility.show ? {} : { focusable: false, skipTaskbar: true }),
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
      // 静默态必须关后台节流:窗口不可见时 Chromium 把定时器/rAF 降频到 ~1Hz,
      // 长回合 e2e 会等不到该收敛的 DOM,表现成"产品坏了"的假红。
      backgroundThrottling: visibility.backgroundThrottling,
      // 拖拽/粘贴文件的绝对路径解析(webUtils.getPathForFile),见 preload.ts。
      preload: resolve(__dirname, "preload.js"),
    },
  });
  mainWindow = win;
  // 窗口最大化状态 → 广播 push(§19.4),renderer 据此切 最大化/还原 图标。
  host.window.onMaximizedChanged((m) => a.gateway.broadcast(IPC.window.maximizedChanged, m));

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
  const base = process.env["ELECTRON_RENDERER_URL"] ?? `http://127.0.0.1:${a.port}/`;
  void win.loadURL(`${base}${base.includes("?") ? "&" : "?"}lt=${a.localToken}`);

  // **静默态永不 show —— 根因修复,勿删**。原实现无条件 `win.show()`:macOS 上 show() 会激活
  // 应用,把用户正在用的窗口焦点和鼠标一起夺走(每跑一次 e2e 打扰一次)。而 e2e 要的是 CDP
  // (求值 / Input 事件 / Page.captureScreenshot),不依赖窗口可见——隐藏窗口照样渲染、照样截图。
  if (visibility.show) win.on("ready-to-show", () => win.show());
}

app.setName("My Harness Desktop");
// Windows toast 硬门槛:应用必须有稳定 AUMID(打包版由 electron-builder NSIS 按 appId 写好,
// dev 态必须手动补,否则系统通知不显示或显示成 Electron)。mac/linux 是 no-op。
app.setAppUserModelId("works.earendil.my-harness-desktop");

app.whenReady().then(async () => {
  // dock 图标尽早设置:createWindow 使进程进入 dock,若 bundle 图标未生效
  // (LaunchServices 缓存陈旧),此处晚于 createWindow 会闪现默认图标。
  // bundle 修复见 assets/scripts/patch-electron.cjs(改 icns 后 touch + lsregister)。
  if (process.platform === "darwin" && app.dock) {
    // 静默态:不设图标并 hide dock —— 应用不参与激活,用户不会被"抢到前台"。
    if (visibility.dockIcon) app.dock.setIcon(resolve(__dirname, "../../assets/icons/icon.png"));
    else void app.dock.hide();
  }

  // 启动编排（14 个步骤，见 bootstrap/boot/steps/）。**必须 try/catch**：
  // 今天这里没有 catch，致命启动失败会变成未捕获拒绝，进程停在"无窗口且不报错"的状态
  // （设计文档 §4.3.4 把这列为阶段一的三处有意改善之一）。Electron 宿主的正确呈现是
  // 给用户一个可见错误框，再以非零码退出——静默停住是最坏的失败形态。
  try {
    assembled = await assemble(host, {
      isPackaged: app.isPackaged,
      rendererDir: resolve(__dirname, "../renderer"),
    });
  } catch (e) {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    console.error("[electron] 启动失败:", msg);
    // nativeAlerts=false（静默态）时不弹框：测试脚本不该被一个模态框挂住。
    if (visibility.nativeAlerts) dialog.showErrorBox("启动失败", msg);
    app.exit(1);
    return;
  }
  const a = assembled;

  createWindow(a);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(a);
  });
}).catch((e) => {
  // 兜底：whenReady 回调里 createWindow 等同步代码抛出也不该变成未捕获拒绝。
  console.error("[electron] 启动阶段未捕获错误:", e);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 应用退出:停所有会话的 pi 进程(多会话多进程,兜底清理)。
// before-quit 是同步事件:preventDefault 阻断退出,等 stopAll(含 kill 链 stdin→SIGTERM→SIGKILL)
// 真正完成再 exit——否则子进程变孤儿(主进程已死,pi 被 init 收养不退出)。
app.on("before-quit", (event) => {
  event.preventDefault();
  // ⚠ **不能写成 `assembled?.sessionStore.stopAll().finally(...)`**：`?.` 短路后整个表达式是
  // `undefined`，`.finally` 不会执行，`app.exit()` 永不调用——而 `preventDefault()` 已经阻断了
  // 本次退出，于是应用**再也退不出去**（启动失败后想关都关不掉）。
  // 用 `?? Promise.resolve()` 让 Promise 链在 assembled 缺席时依然存在。
  void (assembled?.sessionStore.stopAll() ?? Promise.resolve())
    .catch((e) => console.error("[electron] 退出前收尾失败(仍继续退出):", e))
    .finally(() => app.exit());
});
