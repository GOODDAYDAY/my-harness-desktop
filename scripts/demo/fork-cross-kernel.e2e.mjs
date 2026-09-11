#!/usr/bin/env node
// 组合场景 e2e:fork pi 会话 → 派生会话切 dsh 模型 → 发送 → dsh 回复(kernel 归属不漂 pi)。
// 交叉面:fork 派生新会话(4ea26727)× 跨内核切换(80f15807 能力面广播修复)× dsh 落地。
// 这是「派生 × 跨内核」组合猎场(r317 方法论)——单功能探针探不到的 bug 在这里现形。
// 用法: npm run build && node scripts/demo/fork-cross-kernel.e2e.mjs [--port 9350] [--keep]
import { parseArgs } from "node:util";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { centerOfText } from "./lib/interact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9350" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));
// dsh 三件进隔离区(内核目录符号链接,配置/凭证拷贝防写回)
const realHome = homedir();
const realDsh = join(realHome, ".my-harness-desktop-dev", "dsh");
if (existsSync(realDsh)) symlinkSync(realDsh, join(home, ".my-harness-desktop-dev", "dsh"), platform() === "win32" ? "junction" : undefined);
mkdirSync(join(home, ".dsh"), { recursive: true });
for (const f of ["cordis.yml", "settings.yaml", ".credentials.yaml"]) {
  const src = join(realHome, ".dsh", f);
  if (existsSync(src)) copyFileSync(src, join(home, ".dsh", f));
}
const realDshNm = join(realHome, ".dsh", "node_modules");
if (existsSync(realDshNm)) symlinkSync(realDshNm, join(home, ".dsh", "node_modules"), platform() === "win32" ? "junction" : undefined);

// 种 pi 会话(零模型)
const NS = "ns-fork-xkern";
const now = Date.now();
const sessionsDir = join(home, ".my-harness-desktop-dev", "sessions");
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(join(sessionsDir, `${NS}.header.json`), JSON.stringify({
  neutralSessionId: NS, rootLineageId: NS,
  header: { kernel: "pi", cwd: projectDir, createdAt: new Date(now - 60000).toISOString(), name: "forkxk 源", lastMessage: "答完了。", lastEntryId: `${NS}:1`, updatedAt: new Date(now - 1000).toISOString() },
}));
writeFileSync(join(sessionsDir, `${NS}.entries.json`), JSON.stringify({
  neutralSessionId: NS,
  lineages: [{ lineageId: NS, fork: null, entries: [
    { neutralEntryId: `${NS}:0`, message: { role: "user", content: "问个问题", timestamp: now - 50000 } },
    { neutralEntryId: `${NS}:1`, message: { role: "assistant", content: [{ type: "text", text: "答完了。" }], timestamp: now - 49000 } },
  ] }],
}));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18459" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 打开源会话 → fork
  await page.waitForFunction(() => [...document.querySelectorAll("*")].some((e) => (e.textContent || "").trim() === "forkxk 源" && e.children.length < 6), { timeout: 15000, polling: 300 });
  // 点会话行必须用**可信点击**:合成 MouseEvent 对 Radix/React 的行点击不可靠(与 session-single-source 同款修法)。
  const rowPt = await page.evaluate(() => {
    const els = [...document.querySelectorAll("*")].filter((e) => (e.textContent || "").trim() === "forkxk 源" && e.children.length < 6);
    const el = els[els.length - 1];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (rowPt) await page.mouse.click(rowPt.x, rowPt.y);
  // 两阶段收敛(skills §10.3.1):泛条件(messages>0)通过 ≠ 目标那条在 DOM 里——必须等**目标内容**出现再取样。
  // ⚠ 先前的写法是"等一次（**超时被吞**）+ 一次性读 rect"：负载高时那 10s 等不到行，
  //   后面的一次性读拿到 null → 报「找到 assistant 消息行」失败——**错误指向了错误的地方**
  //   （真相是"等超时了"，不是"行不存在"）。改用 centerOfText：等够 + 找不到时说人话。
  const box = await centerOfText(page, "答完了。", { scope: "[data-message-id]", timeoutMs: 25000 });
  ok(!!box, "找到 assistant 消息行");
  await page.mouse.move(box.x, box.y);
  await new Promise((r) => setTimeout(r, 700));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").includes("分叉") && !(x.title || "").includes("确认"));
    b?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").includes("确认分叉"));
    b?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 2000));

  // 派生会话出现(fork 后视图跳到新会话,侧栏有 "(copy)" 行)
  const derived = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-session-path]")];
    return rows.map((r) => r.getAttribute("data-session-path"));
  });
  const derivedNs = derived.find((p) => p && p !== NS && !p.startsWith("new:"));
  ok(!!derivedNs, `fork 派生新会话出现(侧栏 ${derived.length} 行)`);

  // 派生会话切 dsh 模型(跨内核)——稳健选模(参考 kernel-thinking-matrix pickModel)
  const openMenu = async () => {
    const already = await page.evaluate(() => !!document.querySelector("[role='menu']"));
    if (already) return true;
    await page.evaluate(() => {
      const ta = document.querySelector("[data-timeline-composer]");
      const scope = ta?.closest("div")?.parentElement?.parentElement ?? document.body;
      const btns = [...scope.querySelectorAll("button")].filter((b) => b.querySelector("svg") && (b.textContent || "").trim().length > 0);
      const trigger = btns.find((b) => !/^(off|minimal|low|medium|high|xhigh)$/i.test((b.textContent || "").trim()) && (b.textContent || "").trim().length > 2);
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    return page.waitForSelector("[role='menu']", { timeout: 4000 }).then(() => true).catch(() => false);
  };
  const menuOpen = await openMenu();
  if (!menuOpen) {
    // 兜底:真实鼠标坐标点一次(Radix 合成事件有时序窗口)
    await page.evaluate(() => {
      const ta = document.querySelector("[data-timeline-composer]");
      const scope = ta?.closest("div")?.parentElement?.parentElement ?? document.body;
      const btns = [...scope.querySelectorAll("button")].filter((b) => b.querySelector("svg") && (b.textContent || "").trim().length > 0);
      const trigger = btns.find((b) => !/^(off|minimal|low|medium|high|xhigh)$/i.test((b.textContent || "").trim()) && (b.textContent || "").trim().length > 2);
      if (trigger) { const r = trigger.getBoundingClientRect(); trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: r.x + r.width/2, clientY: r.y + r.height/2 })); trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2 })); }
    });
  }
  ok(await page.waitForSelector("[role='menu']", { timeout: 4000 }).then(() => true).catch(() => false), "模型下拉打开");
  // 诊断:menu 结构(tab + 状态 + menuitem)
  const menuDiag = await page.evaluate(() => {
    const menu = document.querySelector("[role='menu']");
    return {
      tabs: [...(menu?.querySelectorAll("button") ?? [])].map((b) => `${b.textContent.trim()}:${b.disabled ? "disabled" : "ok"}`),
      items: [...(menu?.querySelectorAll("[role='menuitem']") ?? [])].map((m) => `${m.textContent.trim().slice(0, 20)}:${(m.getAttribute("aria-disabled") ?? "ok")}`),
    };
  });
  console.log("  诊断 menu:", JSON.stringify(menuDiag).slice(0, 500));
  // 点 dsh 内核 TAB(menu 里的 button,文本恰为 dsh)
  await page.evaluate(() => {
    const menu = document.querySelector("[role='menu']");
    const tab = [...(menu?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim().toLowerCase() === "dsh");
    tab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 600));
  const dshModelPicked = await page.evaluate(() => {
    const items = [...document.querySelectorAll("[role='menuitem']")].filter((m) => m.getBoundingClientRect().width > 0 && (m.getAttribute("aria-disabled") ?? "") !== "true");
    const item = items.find((m) => /ds|deepseek|kimi|qwen/i.test(m.textContent || ""));
    if (!item) return false;
    item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  ok(dshModelPicked, "派生会话选 dsh 模型(跨内核切换未被锁)");
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 6000 }).catch(() => {});

  // 发送 → dsh 回复
  await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, "不要用工具,只回一个词:pong");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => !document.querySelector("[aria-label*='停止']"), { timeout: 120000, polling: 500 }).catch(() => {});
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 8000 }).catch(() => {});

  // 文件对账:派生会话(derivedFrom.kind=fork)的 header.kernel=dsh(不漂 pi)
  // data-session-path 不是 neutralSessionId,得扫中立层找 derivedFrom.kind=fork 的会话
  let derivedKernel = null;
  for (const f of readdirSync(sessionsDir).filter((x) => x.endsWith(".header.json"))) {
    const h = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8"));
    if (h?.header?.derivedFrom?.kind === "fork") { derivedKernel = h.header.kernel; break; }
  }
  ok(derivedKernel === "dsh", `派生会话 kernel=dsh(不漂 pi,实际「${derivedKernel}」)`);

  ok(consoleTail.length === 0, "页面零报错");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(fork 派生 × 跨内核切 dsh,真 token)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
