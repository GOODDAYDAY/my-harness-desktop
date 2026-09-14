// 应用驱动 —— 拉起 electron(CDP 调试端口)、puppeteer-core 连接、发现 renderer 页、退出。
//
// 入口契约与 npm start 同款:electron . --remote-debugging-port=9222(跑 out/ 构建产物,
// app.isPackaged=false → dev 数据根)。连接用 puppeteer-core(已在 devDependencies,零新增依赖)。
//
// **默认静默开窗**(MHD_WINDOW=hidden,见 lib/quiet-env.mjs):窗口永不 show,不抢焦点/鼠标、
// 不弹系统通知;CDP 求值 + Input 事件 + 截图都不依赖窗口可见。要看窗口:MHD_WINDOW=shown。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { quietEnv } from "./quiet-env.mjs";

const require = createRequire(import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 端口已被占用(可能是用户自己开着 npm start)→ 拒绝录制,避免误操作用户窗口。 */
export async function assertPortFree(port) {
  if (await cdpAlive(port)) {
    throw new Error(`端口 ${port} 已有 CDP 服务(可能有 My Harness Desktop 实例在跑)。请先关闭再录制。`);
  }
}

/** 拉起应用并连上 renderer 页。env 可覆盖(隔离 HOME 用)。返回 { child, browser, page }。 */
export async function launchApp({ appDir, port = 9222, timeoutMs = 40000, env: extraEnv } = {}) {
  // **先断言端口空闲**（根因修复，勿删）。此前 launchApp 只等 CDP 就绪：若端口上已有**上一次泄漏
  // 的实例**（某个 e2e 失败路径没 kill 掉 app），`cdpAlive` 立刻为真 → 直接连上**旧实例**，
  // 而新 spawn 的 child 绑不上端口（静默失败）。后果不是报错，而是**断言读到旧进程的状态**：
  // 实测 kernel-plugin-uninstall 第二次运行时，本该是"默认不装载 minimal"的那一步读到了
  // 上一轮 `MHD_ENABLE_KERNELS=minimal` 实例的内核清单，于是假红/假绿都可能出现 ——
  // 这正是"测试说绿但其实测的不是它"的最坏形态。宁可在这一步响亮地失败。
  await assertPortFree(port);
  // node 语境下 require("electron") 返回 electron 可执行文件路径(字符串)
  const electronPath = require("electron");
  // quietEnv:MHD_WINDOW=hidden(默认)——窗口永不 show,不抢用户焦点/鼠标(§5.6)。
  const env = quietEnv({ ...process.env, ...extraEnv });
  delete env.ELECTRON_RUN_AS_NODE;
  // Windows:os.homedir() 读 USERPROFILE(非 HOME)——隔离只覆盖 HOME 时 Node 侧数据根
  // 落回真实 profile(会话/扩展/路径泄漏进录制,剧本状态也不匹配)。同设两变量。
  const args = [appDir, `--remote-debugging-port=${port}`];
  if (extraEnv?.HOME) {
    if (platform() === "win32") {
      // Windows:os.homedir() 读 USERPROFILE(非 HOME)——隔离只覆盖 HOME 时 Node 侧数据根
      // 落回真实 profile(会话/扩展/路径泄漏进录制,剧本状态也不匹配)。同设两变量。
      env.USERPROFILE = extraEnv.HOME;
      // 实测:USERPROFILE 覆盖后 Electron 的 userData 解析失败(启动即退,"Failed to get
      // 'userData' path")——--user-data-dir 强制 userData 落隔离区(不经 USERPROFILE)。
    }
    // 所有平台都强制 userData 落隔离区(HOME 隔离管不到它)。macOS 实测:HOME 只覆盖了
    // 应用自己的配置目录(Node 侧读 $HOME),而 Chromium 的 profile(含 **localStorage**)
    // 走 NSHomeDirectory() → 永远是真实 ~/Library/Application Support/<App>。
    // 后果:同一 MHD_PORT(= 同 origin)的不同运行共享 localStorage——react-resizable-panels
    // 的 autoSaveId 比例、主题/偏好等渲染侧持久态跨运行残留,依赖"首屏是默认布局"的 e2e
    // 会假失败(实测:sidebar-panel.e2e.mjs 第二轮读到上一轮拖出的 30.3% 而非 25%)。
    // 应用代码自身不读 userData(配置全在 HOME 派生目录),故这里只影响 Chromium 侧,
    // 隔离后每次运行都是干净 profile——正是 home.mjs 声明的"一次性 HOME,录完即弃"本意。
    args.push(`--user-data-dir=${join(extraEnv.HOME, "electron-userdata")}`);
  }
  const child = spawn(electronPath, args, {
    cwd: appDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrTail = "";
  child.stderr?.on("data", (d) => {
    stderrTail = (stderrTail + String(d)).slice(-4000);
  });
  child.on("exit", (code) => {
    if (code !== null && code !== 0) console.error(`[demo] electron 退出码 ${code}\n${stderrTail}`);
  });

  const deadline = Date.now() + timeoutMs;
  while (!(await cdpAlive(port))) {
    if (child.exitCode !== null) throw new Error(`electron 启动即退出(${child.exitCode})\n${stderrTail}`);
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`等待 CDP 端口 ${port} 超时(${timeoutMs}ms)`);
    }
    await sleep(250);
  }

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${port}`,
    defaultViewport: null, // 保持窗口原生尺寸(1280×840),不注入虚拟 viewport
    // 长回合/慢端点下,单个 waitForFunction/evaluate 的轮询可能超 180s 的 CDP 默认
    // protocolTimeout——拉到 10 分钟,让「等收敛」类等待由调用方的 timeout 主导,
    // 不被协议层截断成「Runtime.callFunctionOn timed out」假失败(多次实踩)。
    protocolTimeout: 600000,
  });

  // renderer 页:旧架构是 file://…renderer/index.html;web-service 架构改为本地
  // HTTP 服务 http://127.0.0.1:<PORT>/?lt=<token>(assemble PORT=8420,lt=本地鉴权)。
  // 窗口创建后加载有一小段期,轮询等。两种形态都认。
  const isRenderer = (url) =>
    url.includes("renderer/index.html")
    || /^http:\/\/127\.0\.0\.1:\d+\/?\??.*lt=/.test(url);
  let page = null;
  while (!page) {
    for (const p of await browser.pages()) {
      if (isRenderer(p.url())) { page = p; break; }
    }
    if (!page) {
      if (Date.now() > deadline) {
        child.kill("SIGKILL"); // 否则子进程占着调试端口泄漏,下次 assertPortFree 拒跑
        throw new Error("等待 renderer 页超时");
      }
      await sleep(250);
    }
  }
  page.setDefaultTimeout(20000);
  return { child, browser, page };
}

/** 断开 CDP + 终止进程(SIGINT 触发 before-quit 清理链,超时 SIGKILL 兜底)。 */
export async function killApp({ child, browser }) {
  try { browser.disconnect(); } catch { /* 连接可能已断 */ }
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  const deadline = Date.now() + 8000;
  while (child.exitCode === null) {
    if (Date.now() > deadline) { child.kill("SIGKILL"); break; }
    await sleep(150);
  }
}
