#!/usr/bin/env node
// 会话列表韧性 e2e —— 真实产物 + 隔离 HOME，验「一行属于未装载内核的中立会话，不许拖垮整份列表」。
//
// 根因背景（用户报「我现在新建的会话，没有在左侧展示」）：
//   中立层里只要有一行 header.kernel 指向**当前没装载的内核**——minimal 默认 enabled:false，
//   而用户曾用 MHD_ENABLE_KERNELS=minimal 跑过、留下一行归档会话——SessionStore.list() 的
//   map 回调里 catalogFor 抛「未注册的内核」，**整个 list() reject**。renderer 的
//   loadSessionInfos 又把异常吞进空 catch，于是症状是「该项目整个会话列表永久为空、刷新也无效」，
//   而不是「少了一行」。
//
// 本脚本在真实 app 里复现该形态：
//   A) 种两条同 cwd 的中立会话：一条 kernel=pi（已装载），一条 kernel=minimal（默认不装载）；
//   B) 起 app → **两条都要出现在左栏**（列表没被整份拖垮，且孤儿行不蒸发）；
//   C) 直连 sessions.list RPC 复核行数与兜底投影地址（中立 id）；
//   D) 左栏点「+」新建会话 → 新会话壳仍在（列表可用是它的前提）。
//
// 零 token（只读中立层，不发送）。用法：npm run build && node scripts/demo/session-list-orphan-kernel.e2e.mjs [--port 9371] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9371" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const NAME_PI = "正常会话-PI";
const NAME_GHOST = "孤儿内核会话-MINIMAL";
const MARK_PI = "PI-SESSION-MARKER";
/** 孤儿行正文标记:点开它必须能看到正文(内容在中立层,读它不需要内核)。 */
const GHOST_BODY_MARK = "GHOST-BODY-MARKER";

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const proj = join(home, "proj-orphan");
mkdirSync(proj, { recursive: true });
ctx.writeConfig("projects", { recentCwds: [proj] });
ctx.setPrefs({ lastCwd: proj });

/** 直接种中立层（壳自己的存储）：<dataRoot>/sessions/<ns>.header.json。 */
const sessionsDir = join(ctx.dataRoot, "sessions");
mkdirSync(sessionsDir, { recursive: true });

function seedNeutral(ns, kernel, name, entries) {
  writeFileSync(
    join(sessionsDir, `${ns}.header.json`),
    JSON.stringify({
      neutralSessionId: ns,
      rootLineageId: ns,
      header: { kernel, cwd: proj, createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z", name },
    }),
  );
  writeFileSync(
    join(sessionsDir, `${ns}.entries.json`),
    JSON.stringify({
      neutralSessionId: ns,
      lineages: [{ lineageId: ns, fork: null, entries }],
    }),
  );
}

const NS_PI = "11111111-2222-3333-4444-555555555555";
const NS_GHOST = "99999999-8888-7777-6666-555555555555";
seedNeutral(NS_PI, "pi", NAME_PI, [
  { neutralEntryId: `${NS_PI}:0`, message: { role: "user", content: MARK_PI } },
  { neutralEntryId: `${NS_PI}:1`, message: { role: "assistant", content: [{ type: "text", text: `${MARK_PI}-REPLY` }] } },
]);
// 关键：内核 minimal 默认**不装载**（plugin.json enabled:false）。这一行就是实弹里的孤儿行。
seedNeutral(NS_GHOST, "minimal", NAME_GHOST, [
  { neutralEntryId: `${NS_GHOST}:0`, message: { role: "user", content: GHOST_BODY_MARK } },
]);
console.log(`  种子中立会话: pi=${NS_PI} / minimal(未装载)=${NS_GHOST} @ ${proj}`);

const shotsDir = join(runRoot, "shots");
mkdirSync(shotsDir, { recursive: true });
let shotN = 0;
const shot = async (page, name) => {
  shotN += 1;
  await page.screenshot({ path: join(shotsDir, `${String(shotN).padStart(2, "0")}-${name}.png`) });
};

/** 左栏会话列表里所有行的标题文本。 */
const rowNames = (page) => page.evaluate(() =>
  [...document.querySelectorAll("[data-session-path]")].map((el) => (el.textContent || "").trim()));

let app = null;
try {
  app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18471" }, timeoutMs: 90000 });
  const page = app.page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  await shot(page, "boot");

  // ── B) 左栏必须出两条行（此前整份列表被一行坏数据拖垮 ⇒ 一条都没有） ──
  const names = await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll("[data-session-path]")].map((el) => (el.textContent || ""));
      return rows.length >= 2 ? rows : null;
    },
    { timeout: 20000, polling: 300 },
  ).then((h) => h.jsonValue()).catch(() => []);
  ok(names.length >= 2, `左栏出现 ≥2 条会话行（实际 ${names.length}）：一行未装载内核不许拖垮整份列表`);
  ok(names.some((n) => n.includes(NAME_PI)), `正常（pi）会话可见：${NAME_PI}`);
  ok(names.some((n) => n.includes(NAME_GHOST)), `未装载内核（minimal）的会话**不蒸发**，仍作为中立会话列出：${NAME_GHOST}`);
  await shot(page, "list-ok");

  // ── C) 直连 RPC 复核（UI 之外的第二条证据面） ──
  const rpc = await page.evaluate(async (cwd) => {
    try {
      const rows = await window.kernel.sessions.list(cwd);
      return { ok: true, rows: rows.map((r) => ({ ns: r.neutralSessionId, path: r.path, name: r.name })) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }, proj);
  ok(rpc.ok, `sessions.list RPC 不再整份 reject（此前是 HANDLER_ERROR「未注册的内核」）${rpc.ok ? "" : `：${rpc.error}`}`);
  if (rpc.ok) {
    ok(rpc.rows.length >= 2, `RPC 返回 ${rpc.rows.length} 行（≥2）`);
    const ghost = rpc.rows.find((r) => r.ns === NS_GHOST);
    ok(!!ghost, "RPC 行里含未装载内核的那条（不丢行）");
    ok(ghost && ghost.path === NS_GHOST, `未装载内核的行退回中立 id 作投影地址（实际 ${ghost?.path}）`);
    const pi = rpc.rows.find((r) => r.ns === NS_PI);
    ok(pi && pi.path !== NS_PI, "已装载内核的行仍用内核投影地址（兜底不污染正常行）");
  }
  console.log(`  （诊断）控制台 error 数=${consoleErrors.length}${consoleErrors.length ? " 首条: " + consoleErrors[0].slice(0, 160) : ""}`);
  // 后端那条"内核未装载"的日志是**有意保留**的可观测性（不静默，级别已降到 warn——这是预期内的
  // 降级态而不是故障），所以这里只断言没有"未捕获异常"这类真故障，不断言控制台零 error。
  ok(errors.length === 0, `无未捕获 pageerror（实际 ${errors.length}）`);

  // ── D) 点「+」新建会话：列表可用性是新会话能用的前提 ──
  const plusRect = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("[data-sidebar-style] button")].find((b) => (b.getAttribute("title") || "").length > 0 && b.querySelector("svg"));
    if (!btn) return null;
    btn.scrollIntoView({ block: "nearest" });
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, title: btn.getAttribute("title") };
  });
  if (plusRect) {
    await page.mouse.click(plusRect.x, plusRect.y);
    await waitForDomIdle(page, { quietMs: 700, timeoutMs: 12000 });
    const after = await rowNames(page);
    ok(after.length >= 2, `新建会话后列表仍显示原会话（${after.length} 行）`);
    await shot(page, "after-new-chat");
  } else {
    console.log("  ⚠ 未找到「+」按钮锚点，跳过 D 段（不伪造通过）");
  }

  // ── E) 点这一行：内容**(中立层)读得开**、输入框显式降级、侧栏有角标 ──
  // 上一版只修了 list()：行列得出来但**点不开**(openSession 经 neutralToSessionInfo 无守卫调
  // catalogFor → 抛「未注册的内核」→ renderer 只写 console → 用户看到"点了没反应")，
  // 而且当时还删不掉。这一段落钉住"可读 + 显式降级 + 可清理"三件事。
  const ghostRowClicked = await page.evaluate((name) => {
    const el = [...document.querySelectorAll("[data-session-path]")].find((e) => (e.textContent || "").includes(name));
    if (!el) return false;
    el.scrollIntoView({ block: "nearest" });
    return true;
  }, NAME_GHOST);
  ok(ghostRowClicked, "找到孤儿行的 DOM 锚点");
  const ghostRect = await page.evaluate((name) => {
    const el = [...document.querySelectorAll("[data-session-path]")].find((e) => (e.textContent || "").includes(name));
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, NAME_GHOST);
  await page.mouse.click(ghostRect.x, ghostRect.y);
  await waitForDomIdle(page, { quietMs: 1000, timeoutMs: 15000 });
  const bodyText = await page.evaluate(() => document.body.innerText || "");
  ok(bodyText.includes(GHOST_BODY_MARK), "点开孤儿行：正文出现会话内容（内容在中立层，读它不需要内核）");
  ok(!consoleErrors.some((t) => t.includes("打开会话失败")), "点开孤儿行不再抛「打开会话失败」（此前只进 console，用户看到的是点了没反应）");
  ok(bodyText.includes("未装载"), "输入框换成只读条并说明原因（显式降级，不静默、不假装可用）");
  const composerGone = await page.evaluate(() => document.querySelectorAll("[data-timeline-composer]").length === 0);
  ok(composerGone, "只读条态下没有可发送的输入框（避免「看得见的历史不参与上下文」的静默换内核续跑）");
  const badge = await page.evaluate(() => document.querySelectorAll('[data-session-kernel-unloaded="true"]').length);
  ok(badge >= 1, `侧栏给这一行内核未装载角标（found ${badge}）`);
  await shot(page, "ghost-opened");

  // ── F) 归档 / 改名：纯中立写，内核没装载也要成功（此前 catalogFor 在 try 之外，全抛） ──
  const writes = await page.evaluate(async ({ ns, cwd }) => {
    const out = {};
    try { await window.kernel.sessions.updateHeader(ns, { archived: true }); out.header = "ok"; } catch (e) { out.header = "throw:" + (e?.message ?? e); }
    try { await window.kernel.sessions.renameSession(ns, "改名后的孤儿"); out.rename = "ok"; } catch (e) { out.rename = "throw:" + (e?.message ?? e); }
    try { const rows = await window.kernel.sessions.list(cwd); out.row = rows.find((r) => r.neutralSessionId === ns) ?? null; } catch (e) { out.row = "throw:" + (e?.message ?? e); }
    return out;
  }, { ns: NS_GHOST, cwd: proj });
  console.log(`  （诊断）updateHeader → ${writes.header}；rename → ${writes.rename}`);
  ok(writes.header === "ok", "归档孤儿行成功（纯中立写）");
  ok(writes.rename === "ok", "给孤儿行改名成功（纯中立写）");
  ok(writes.row && writes.row.archived === true && writes.row.name === "改名后的孤儿", "两条写都落到了中立层（列表行读到 archived/name）");

  // ── G) 删除：用户拿这一行有办法（此前内核侧删除先抛，中立级联删根本没执行） ──
  // 先切到 pi 行再删：活跃会话禁止删除是既有的机制兜底（UI 侧 deletable 过滤同一条语义——
  // 进程 append 会让文件复活），不是本段要验的东西；不切走会读到"删了但还在"的假红。
  const piRect = await page.evaluate((name) => {
    const el = [...document.querySelectorAll("[data-session-path]")].find((e) => (e.textContent || "").includes(name));
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, NAME_PI);
  await page.mouse.click(piRect.x, piRect.y);
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 12000 });
  const del = await page.evaluate(async ({ ns, cwd }) => {
    const out = {};
    try { await window.kernel.sessions.deleteSessions([ns]); out.del = "ok"; } catch (e) { out.del = "throw:" + (e?.message ?? e); }
    try { const rows = await window.kernel.sessions.list(cwd); out.after = rows.map((r) => r.neutralSessionId); } catch (e) { out.after = "throw:" + (e?.message ?? e); }
    return out;
  }, { ns: NS_GHOST, cwd: proj });
  console.log(`  （诊断）deleteSessions → ${del.del}；删除后 list → ${JSON.stringify(del.after)}`);
  ok(del.del === "ok", "删除孤儿行成功（内核侧删除 best-effort，中立级联删必执行）");
  ok(Array.isArray(del.after) && !del.after.includes(NS_GHOST), "删完它就从列表里消失了（不留删不掉的死行）");
  ok(Array.isArray(del.after) && del.after.includes(NS_PI), "正常 pi 行不受影响");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言（会话列表韧性：一行未装载内核不许拖垮整份列表，且这一行可读/可改/可删，零 token）`);
  console.log(`   截图: ${shotsDir}`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  if (args.keep) console.error(`   现场保留: ${runRoot}`);
  if (app) await killApp(app).catch(() => {});
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(1);
}
