// 应用驱动 —— 拉起 electron(CDP 调试端口)、puppeteer-core 连接、发现 renderer 页、退出。
//
// 入口契约与 npm start 同款:electron . --remote-debugging-port=9222(跑 out/ 构建产物,
// app.isPackaged=false → dev 数据根)。连接用 puppeteer-core(已在 devDependencies,零新增依赖)。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

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
  // node 语境下 require("electron") 返回 electron 可执行文件路径(字符串)
  const electronPath = require("electron");
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  // Windows:os.homedir() 读 USERPROFILE(非 HOME)——隔离只覆盖 HOME 时 Node 侧数据根
  // 落回真实 profile(会话/扩展/路径泄漏进录制,剧本状态也不匹配)。同设两变量。
  const args = [appDir, `--remote-debugging-port=${port}`];
  if (extraEnv?.HOME && platform() === "win32") {
    env.USERPROFILE = extraEnv.HOME;
    // 实测:USERPROFILE 覆盖后 Electron 的 userData 解析失败(启动即退,"Failed to get
    // 'userData' path")——--user-data-dir 强制 userData 落隔离区(不经 USERPROFILE)。
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
