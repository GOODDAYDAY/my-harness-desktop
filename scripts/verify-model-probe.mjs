#!/usr/bin/env node
// 一次性验证:模型发现 + Ping 功能(设置页 → 模型 TAB → 从 Base URL 发现区块)。
// 流程:本地 mock 网关(/v1/models + /v1/chat/completions)→ 起 electron(构建产物)→
// CDP 驱动 UI 加临时 provider(不保存,不碰真实 models.json)→ 扫描 → 全部 Ping → 截图 + DOM 断言。
// 产物:/tmp/mhd-probe-verify-<ts>/(report.json + 截图)。
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { quietEnv } from "./demo/lib/quiet-env.mjs";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = `/tmp/mhd-probe-verify-${TS}`;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { outDir: OUT, checks: [], screenshots: [], consoleErrors: [], ok: false };
const log = (...a) => console.log(`[probe-verify] ${a.map(String).join(" ")}`);
function check(name, ok, detail = "") {
  report.checks.push({ name, ok: !!ok, detail: String(detail) });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
async function shot(page, name) {
  try { await page.screenshot({ path: join(OUT, name) }); report.screenshots.push(name); }
  catch (e) { log("截图失败", name, e.message); }
}

// ---------- 0. mock 网关 ----------
const gateway = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "mock-reasoner" }, { id: "mock-chat" }, { id: "mock-embed" }] }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const model = JSON.parse(body || "{}").model;
      if (model === "mock-embed") {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { message: "model not found" } }));
        return;
      }
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "pong" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      }, 120);
    });
    return;
  }
  res.statusCode = 404; res.end("nf");
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${gateway.address().port}`; // 不带 /v1：探测的路径候选要自己回落到 /v1/*
log(`mock 网关: ${GW}`);

// ---------- 1. 预检 + 起 electron ----------
const CDP_PORT = 9222, SVC_PORT = 8420;
const cdpAlive = async () => { try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1200) }); return r.ok; } catch { return false; } };
if (await cdpAlive()) { log("9222 被占用,退出"); process.exit(1); }

// quietEnv:默认 MHD_WINDOW=hidden ⇒ 窗口永不 show,不抢焦点(§5.6)。
const env = quietEnv(process.env); delete env.ELECTRON_RUN_AS_NODE;
const electronLog = createWriteStream(join(OUT, "electron.log"));
const child = spawn(require("electron"), [ROOT, `--remote-debugging-port=${CDP_PORT}`, "--no-sandbox"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout?.pipe(electronLog); child.stderr?.pipe(electronLog);
let electronExited = null;
child.on("exit", (code, signal) => { electronExited = { code, signal }; });

let browser = null, page = null;
async function teardown() {
  try { browser?.disconnect(); } catch {}
  if (child.exitCode === null && electronExited === null) {
    child.kill("SIGINT");
    const deadline = Date.now() + 8000;
    while (child.exitCode === null && Date.now() < deadline) await sleep(150);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await sleep(400);
  for (const port of [SVC_PORT, CDP_PORT]) {
    try { execSync(`lsof -ti tcp:${port} | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch {}
  }
  gateway.close();
}

const hasText = (cands) => (el) => cands.some((c) => (el.textContent ?? "").includes(c));

try {
  const deadline = Date.now() + 45000;
  while (!(await cdpAlive())) {
    if (electronExited) throw new Error(`electron 启动即退出 ${JSON.stringify(electronExited)}`);
    if (Date.now() > deadline) throw new Error("等 CDP 超时");
    await sleep(300);
  }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null, protocolTimeout: 120000 });
  const findPage = async () => {
    for (const p of await browser.pages()) {
      const u = p.url();
      if (u.includes(`127.0.0.1:${SVC_PORT}`) || u.includes("index.html")) return p;
    }
    return null;
  };
  const pageDeadline = Date.now() + 30000;
  while (!page) {
    page = await findPage();
    if (!page) { if (Date.now() > pageDeadline) throw new Error("等 renderer 页超时"); await sleep(300); }
  }
  page.setDefaultTimeout(30000);
  page.on("console", (m) => { if (m.type() === "error") report.consoleErrors.push(m.text().slice(0, 300)); });
  await page.waitForFunction(() => !!window.kernel?.plugins?.list, { timeout: 30000 });
  // 应用就绪后可能发生一次重定向(login gate → 带 lt 的 URL),旧 execution context 会被销毁。
  // 等稳定后重新解析页面句柄,后续所有操作用新句柄。
  await sleep(2500);
  page = (await findPage()) ?? page;
  await page.waitForFunction(() => !!window.kernel?.plugins?.list, { timeout: 30000 });
  page.setDefaultTimeout(30000);
  page.on("console", (m) => { if (m.type() === "error") report.consoleErrors.push(m.text().slice(0, 300)); });
  check("app 拉起 + window.kernel 就绪", true);

  // ---------- 2. IPC 面直连断言(不经 UI) ----------
  const ipc = await page.evaluate(async (gw) => {
    const d = await window.kernel.modelsProbe.discover({ baseUrl: gw, apiKey: "mock", api: "openai-completions" });
    const p1 = await window.kernel.modelsProbe.ping({ baseUrl: gw, apiKey: "mock", model: "mock-chat" });
    const p2 = await window.kernel.modelsProbe.ping({ baseUrl: gw, apiKey: "mock", model: "mock-embed" });
    const p3 = await window.kernel.modelsProbe.ping({ baseUrl: gw, api: "google-genai", model: "x" });
    return { d, p1, p2, p3 };
  }, GW);
  check("IPC discover: 返回排序后的模型清单", ipc.d.ok && JSON.stringify(ipc.d.models) === JSON.stringify(["mock-chat", "mock-embed", "mock-reasoner"]), JSON.stringify(ipc.d));
  check("IPC ping 成功: ok + latencyMs", ipc.p1.ok === true && typeof ipc.p1.latencyMs === "number", JSON.stringify(ipc.p1));
  check("IPC ping 404: ok:false + 状态码", ipc.p2.ok === false && String(ipc.p2.error).includes("404"), JSON.stringify(ipc.p2));
  check("IPC ping google-genai 饱和覆盖(openai 形状命中)", ipc.p3.ok === true && ipc.p3.via === "openai-chat", JSON.stringify(ipc.p3));

  // ---------- 3. UI:进设置 → Pi → 模型 TAB ----------
  await page.waitForSelector("[data-sidebar-style]", { timeout: 15000 });
  await sleep(4000); // 插件异步加载宽限

  /** 用原生鼠标点击（React 合成事件对合成 MouseEvent 偶尔不敏感）；找不到等 1s 重试,最多 5 次。 */
  const nativeClick = async (cands, what) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const handle = await page.evaluateHandle((cs) => {
        const els = [...document.querySelectorAll("button, div, span, a")];
        const el = els.find((e) => {
          if (!e.checkVisibility?.()) return false;
          const txt = (e.textContent?.trim() ?? "");
          return cs.some((c) => txt === c);
        });
        return el ? (el.closest("button") ?? el) : null;
      }, cands);
      const el = handle.asElement();
      if (el) {
        await el.click();
        check(`点击 ${what}`, true, cands.join("/"));
        await sleep(1000);
        return true;
      }
      await sleep(1000);
    }
    const dump = await page.evaluate(() => document.body.innerText.slice(0, 600));
    check(`点击 ${what}`, false, `未找到 ${cands.join("/")}；当前页面文本: ${dump.replace(/\s+/g, " ").slice(0, 300)}`);
    return false;
  };

  const openedSettings = await nativeClick(["设置", "Settings", "Einstellungen"], "侧栏设置入口");
  if (!openedSettings) throw new Error("设置页打不开");
  await sleep(1200);

  const clickByText = nativeClick;
  await clickByText(["Pi"], "设置列表 Pi 入口");
  await clickByText(["模型", "Models", "Modelle"], "模型 TAB");
  await shot(page, "01-models-tab.png");

  // ---------- 4. 加临时 provider 指向 mock 网关(不保存) ----------
  await clickByText(["+ 添加供应商", "+ Add provider", "+ Anbieter hinzufügen"], "添加供应商");
  const filled = await page.evaluate((gw) => {
    const setVal = (label, value) => {
      const lab = [...document.querySelectorAll("label")].find((l) => l.textContent?.trim() === label && l.checkVisibility?.());
      if (!lab) return false;
      const input = lab.parentElement.querySelector("input");
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };
    return { base: setVal("baseUrl", gw), key: setVal("API Key", "mock-key") };
  }, GW);
  check("填 baseUrl + apiKey(临时 provider)", filled.base && filled.key, JSON.stringify(filled));
  await sleep(600);

  // 发现区块默认收起:先断言扫描按钮不可见(不占版面),再点 baseUrl 行内开关展开
  const hiddenBefore = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /扫描模型|Scan models/.test(b.textContent ?? ""));
    return btn ? !btn.checkVisibility() : null;
  });
  check("默认收起:扫描按钮不可见(不占版面)", hiddenBefore === true, String(hiddenBefore));
  await clickByText(["发现模型", "Discover", "Entdecken"], "baseUrl 行内「发现模型」开关");
  const visibleAfter = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /扫描模型|Scan models/.test(b.textContent ?? ""));
    return btn?.checkVisibility() ?? false;
  });
  check("点击后展开:扫描按钮可见", visibleAfter === true);

  // ---------- 5. 扫描 → 行渲染 ----------
  await clickByText(["扫描模型", "Scan models", "Modelle scannen"], "扫描模型");
  const rowsOk = await page.waitForFunction(() => {
    const t = document.body.innerText;
    return t.includes("mock-chat") && t.includes("mock-reasoner") && t.includes("mock-embed");
  }, { timeout: 15000 }).then(() => true).catch(() => false);
  if (!rowsOk) {
    const dump = await page.evaluate(() => {
      const t = document.body.innerText;
      const i = t.indexOf("发现");
      return t.slice(Math.max(0, i - 100), i + 500);
    });
    log("扫描后区块文本:", JSON.stringify(dump));
  }
  check("扫描后列出 3 个 mock 模型", rowsOk);
  await shot(page, "02-discovered.png");

  // ---------- 6. 全部 Ping → 结果与耗时 ----------
  await clickByText(["全部 Ping", "Ping all", "Alle pingen"], "全部 Ping");
  const pingDone = await page.waitForFunction(() => {
    const t = document.body.innerText;
    const okCount = (t.match(/✓\s*\d/g) ?? []).length;
    const errCount = (t.match(/✗\s*[\d.]+[a-z]*\s*·\s*HTTP 404/g) ?? []).length;
    return okCount >= 2 && errCount >= 1;
  }, { timeout: 30000 }).then(() => true).catch(() => false);
  check("全部 Ping: 2✓ + 1✗(mock-embed 404)", pingDone);
  await shot(page, "03-ping-results.png");

  // ---------- 7. 「+ 添加」把 mock-chat 加进配置模型列表(不落盘) ----------
  const added = await page.evaluate(() => {
    const label = [...document.querySelectorAll("span")].find((s) => s.textContent?.trim() === "mock-chat" && s.checkVisibility?.());
    const row = label?.closest("div[style*='grid']");
    if (!row) return false;
    const btn = [...row.querySelectorAll("button")].find((b) => /添加|Add/.test(b.textContent ?? ""));
    if (!btn) return false;
    btn.click();
    return true;
  });
  check("点「+ 添加」", added);
  await sleep(900);
  const addedVisible = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll("input")].map((i) => i.value);
    return inputs.includes("mock-chat");
  });
  check("mock-chat 出现在上方配置模型列表(未保存的内存态)", addedVisible);
  await shot(page, "04-added.png");

  report.ok = report.checks.every((c) => c.ok);
} catch (err) {
  log("致命错误:", err.message);
  report.fatal = String(err.stack ?? err);
  if (page) await shot(page, "99-fatal.png");
} finally {
  report.consoleErrors = report.consoleErrors.slice(0, 20);
  await teardown();
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
}
log(`\n===== ${report.ok ? "ALL PASS ✅" : "存在失败 ❌"} =====  报告: ${OUT}/report.json`);
for (const c of report.checks) if (!c.ok) log(`  FAIL ${c.name} — ${c.detail}`);
process.exit(report.ok ? 0 : 1);
