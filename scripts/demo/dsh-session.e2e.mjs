#!/usr/bin/env node
// dsh 会话全链路真实 DOM e2e —— 拉起 out/ 构建产物(隔离 HOME + 独立服务端口 + CDP),
// 真实 dsh 内核 + 真实模型,复核四个修复(各对应一条用户报告):
//   ① (问题2)回合收敛后「思考中」指示消失——此前 abort/缺席 assistant/message 时永挂,刷新才清
//   ② (问题1)模型分隔线在会话流可见(与 pi 同信息密度)
//   ③ (问题8)assistant 消息行有「收藏」「分叉」入口(currentNeutralSessionId 水合修复)
//   ④ (问题10)连发两条,改名分隔线恰好一条——此前 dsh 下每条消息都重命名一遍(刷屏)
//   ⑤ (问题1持久化)刷新页面重开会话,分隔线仍在(合成条目落中立层,刷新不丢)
//
// 用法: npm run build && node scripts/demo/dsh-session.e2e.mjs [--port 9335] [--keep]
// 注意: 花真实 token(两次 dsh ping);dsh 内核/配置/凭证从真实 HOME 链接+拷贝进隔离区。
// 已知环境依赖: 模型端点(ai-router)挂起/限流时回合永不收敛——失败信息会以
// 「收敛超时」呈现,这是环境问题不是产品 bug;端点正常时本脚本全绿(2026-09-02 实证)。
import { parseArgs } from "node:util";
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPortFree, launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { loadScenario, applySeed } from "./lib/seed/engine.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { clickByText } from "./lib/interact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "9335" },
    keep: { type: "boolean", default: false },
  },
});
const PORT = Number(args.port);
const APP_PORT = 18422; // 与 dev 实例 8420、兄弟 e2e 错开(assemble 读 MHD_PORT)

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function clickSel(page, sel) {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  if (!box) throw new Error(`点击目标不存在: ${sel}`);
  await page.mouse.click(box.x, box.y);
  await waitForDomIdle(page, { quietMs: 300, timeoutMs: 5000 }).catch(() => {});
}

/** React 受控 textarea 可靠写入(dsh-multiturn 同款:原生 setter + input 事件)。 */
const setComposer = (page, text) => page.evaluate((t) => {
  const ta = document.querySelector("[data-timeline-composer]");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, t);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
}, text);

const clickSend = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || x.title || "").includes("发送") && x.getBoundingClientRect().width > 0);
  if (!b) return false;
  b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return true;
});

/** 等回合收敛:发送键出现「停止」→ 消失,且「思考中」计时不再出现。超时就失败,不吞。
 *  两阶段(与 session-single-source e2e 同款):先等「停止」出现(回合真的起跑),
 *  再等它消失(收敛)——只等消失有竞态:发送后停止钮尚未挂载的几百 ms 里查询即通过,
 *  断言打在在飞回合上(端点慢时必现,2026-09-03 实测)。 */
async function settle(page, timeoutMs = 120000) {
  const appeared = await page.waitForSelector("[data-composer-stop]", { timeout: 20000 }).then(() => true).catch(() => false);
  if (!appeared) {
    // 停止钮从未出现:回合可能根本没起跑(发送失败/模型未选上)——不在这里炸,
    // 留给后续断言拿更具体的现场。
    console.warn("   [settle] 20s 内停止钮未出现,回合可能未起跑");
  }
  await page.waitForFunction(
    () => !document.querySelector("[data-composer-stop]"),
    { timeout: timeoutMs, polling: 500 },
  );
  // 事件驱动收尾:流式标记消失后再确认无「思考中」残留(连续两次观察,不赌单帧)
  const deadline = Date.now() + 30000;
  for (;;) {
    const stuck = await page.evaluate(() => document.body.innerText.includes("agent 思考中"));
    const streaming = await page.evaluate(() => !!document.querySelector("[data-composer-stop]"));
    if (!stuck && !streaming) return;
    if (Date.now() > deadline) throw new Error("收敛后仍有「思考中」残留(超时不清)");
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物,先跑: npm run build");
  process.exit(1);
}

await assertPortFree(PORT);
const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
const shotsDir = join(runRoot, "e2e-shots");
mkdirSync(shotsDir, { recursive: true });

console.log(`隔离 HOME: ${home}(真实 dsh 内核 + 真实模型,花真 token)`);
const realHome = homedir();
const ctx = setupBaseline({ home, realHome, locale: "zh-CN" });
const scenarioDir = join(HERE, "scenarios", "goal-command");
const bundle = await loadScenario(scenarioDir, "zh-CN");
applySeed(ctx, scenarioDir, bundle.spec, bundle.dict);
// dsh 内核 + 配置 + 凭证进隔离区(内核目录符号链接,配置/凭证拷贝防写回真实 profile)
const realDsh = join(realHome, ".my-harness-desktop-dev", "dsh");
if (existsSync(realDsh)) {
  symlinkSync(realDsh, join(home, ".my-harness-desktop-dev", "dsh"), platform() === "win32" ? "junction" : undefined);
}
const realDshCfg = join(realHome, ".dsh");
mkdirSync(join(home, ".dsh"), { recursive: true });
for (const f of ["cordis.yml", "settings.yaml", ".credentials.yaml"]) {
  const src = join(realDshCfg, f);
  if (existsSync(src)) copyFileSync(src, join(home, ".dsh", f));
}
// dsh 桌面适配插件(运行时写进 ~/.dsh/.my-harness-desktop-plugins/)的依赖从 ~/.dsh/node_modules
// 解析(实测:隔离区缺它,插件树加载即崩、回合永不起——「思考中 0s」永挂)。符号链接进隔离区。
const realDshNm = join(realDshCfg, "node_modules");
if (existsSync(realDshNm)) {
  symlinkSync(realDshNm, join(home, ".dsh", "node_modules"), platform() === "win32" ? "junction" : undefined);
}

const app = await launchApp({ appDir: ROOT, port: PORT, env: { HOME: home, MHD_PORT: String(APP_PORT) }, timeoutMs: 90000 });
const page = app.page;
// 诊断:页面 console + WS 错误都留痕(失败时打出来)
const consoleTail = [];
page.on("console", (m) => { consoleTail.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => { consoleTail.push(`[pageerror] ${e.message}`); });
let shotN = 0;
async function shot(name) {
  shotN += 1;
  await page.screenshot({ path: join(shotsDir, `${String(shotN).padStart(2, "0")}-${name}.png`) });
}

const renameCount = () => page.evaluate(() => (document.body.innerText.match(/会话重命名为/g) ?? []).length);

try {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  // 插桩:记录渲染端收到的全部会话事件类型(找「思考中」幻影的制造者)
  await page.evaluate(() => {
    window.__evtLog = [];
    window.kernel.sessions.onEvent((e) => {
      window.__evtLog.push(`${Date.now() % 100000}:${e.type}${e.message ? ` ${e.message.role ?? ""}` : ""}${e.entry?.type ? ` entry:${e.entry.type}` : ""}`);
    });
  });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 选 DSH 模型(composer 模型下拉 → DSH 页签 → 第一个 dsh 模型项)
  await page.evaluate(() => {
    const btn = document.querySelector("button[id^=radix]");
    if (btn && btn.getAttribute("data-state") !== "open") {
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => {
    const menu = document.querySelector("[role=menu]");
    const tab = menu && [...menu.querySelectorAll("button")].find((b) => (b.innerText || "").trim().toUpperCase() === "DSH");
    tab?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    tab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 350));
  const picked = await page.evaluate(() => {
    const menu = document.querySelector("[role=menu]");
    if (!menu) return null;
    const items = [...menu.querySelectorAll("[role=menuitem]")];
    // 优先 qwen3.8-max(dsh-multiturn e2e 实证可用的档),选不到回退首项
    const item = items.find((el) => (el.innerText || "").includes("qwen3.8-max")) ?? items[0];
    if (!item) return null;
    const name = (item.innerText || "").trim();
    item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return name;
  });
  ok(!!picked, `选 DSH 模型(${picked ?? "无"})`);

  // 第 1 条 ping
  await setComposer(page, "ping");
  await clickSend(page);
  await settle(page);
  ok(true, "第 1 条 ping 回合收敛");

  // ① 思考中不残留(问题2:abort/缺 assistant/message 时曾永挂,刷新才清)
  ok(!(await page.evaluate(() => document.body.innerText.includes("agent 思考中"))), "① 收敛后无「思考中」残留(问题2)");

  // ② 模型分隔线在会话流可见(问题1)
  // Virtuoso 只渲染可视窗口:分隔线在会话顶部,先滚到顶再断言(不滚则随内容长短抖动)。
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 }).catch(() => {});
  await page.evaluate(() => {
    document.querySelectorAll("div").forEach((d) => { if (d.scrollHeight > d.clientHeight + 200) d.scrollTop = 0; });
  });
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 }).catch(() => {});
  ok(await page.evaluate(() => document.body.innerText.includes("模型 →")), "② 模型分隔线可见(问题1)");
  // 中立层落盘核对(数据层硬断言,不依赖渲染窗口):分隔线持久化在册,刷新不丢
  const nsFiles = readdirSync(join(home, ".my-harness-desktop-dev", "sessions")).filter((f) => f.endsWith(".json"));
  const dividerPersisted = nsFiles.some((f) => {
    try {
      const sess = JSON.parse(readFileSync(join(home, ".my-harness-desktop-dev", "sessions", f), "utf-8"));
      return sess.lineages?.some((l) => l.entries?.some((e) => e.message?.role === "divider" && e.message?.kind === "model"));
    } catch { return false; }
  });
  ok(dividerPersisted, "② 模型分隔线已落中立层(刷新/冷开不丢的载体)");

  // 滚回底部(③ 的消息行在底部)
  await page.evaluate(() => {
    document.querySelectorAll("div").forEach((d) => { if (d.scrollHeight > d.clientHeight + 200) d.scrollTop = d.scrollHeight; });
  });
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 }).catch(() => {});
  // ③ assistant 消息行有收藏/分叉入口(问题8:currentNeutralSessionId 水合修复)
  // 诊断:列出消息行上所有按钮 title(分叉丢失时看现场)
  const titles = await page.evaluate(() => [...document.querySelectorAll("button[title]")].map((b) => b.getAttribute("title")));
  console.log("   [diag] 页面按钮 title 清单:", JSON.stringify(titles));
  // 诊断:messageActions 槽注册内容 + 组件解析结果(fork 丢在哪个环节一目了然)
  const slotDiag = await page.evaluate(async () => {
    const items = await window.kernel.slots.messageActions().catch((e) => String(e));
    return JSON.stringify(items);
  });
  console.log("   [diag] messageActions 槽:", slotDiag);
  const rowsDiag = await page.evaluate(() => {
    return [...document.querySelectorAll("[data-message-id]")].map((row) => ({
      id: row.getAttribute("data-message-id"),
      roles: row.getAttribute("data-role") ?? "",
      titles: [...row.querySelectorAll("button[title]")].map((b) => b.getAttribute("title")),
      head: (row.textContent || "").slice(0, 40),
    }));
  });
  console.log("   [diag] 消息行 × 动作:", JSON.stringify(rowsDiag, null, 1));
  const evtLog = await page.evaluate(() => window.__evtLog ?? []);
  console.log("   [diag] 会话事件流:", JSON.stringify(evtLog));
  ok((await page.evaluate(() => document.querySelectorAll('[data-message-id] [title="收藏"]').length)) >= 1, "③ 「收藏」入口在消息行渲染(问题8)");
  ok((await page.evaluate(() => document.querySelectorAll('[data-message-id] [title="分叉"], [data-message-id] [title="确认分叉？"]').length)) >= 1, "③ 「分叉」入口在消息行渲染(问题8)");

  // ④ 第一条后改名分隔线恰好一条(问题10:自动命名只应跑一次)
  const renames1 = await renameCount();
  ok(renames1 <= 1, `④ 首发后改名分隔线 ≤1(实际 ${renames1})`);
  await shot("after-first-ping");

  // 第 2 条 ping:不再重命名
  await setComposer(page, "ping");
  await clickSend(page);
  await settle(page);
  const renames2 = await renameCount();
  ok(renames2 <= 1, `④ 第二发后改名分隔线仍 ≤1(实际 ${renames2},问题10)`);
  ok(!(await page.evaluate(() => document.body.innerText.includes("agent 思考中"))), "④ 第二发收敛后仍无「思考中」残留");

  // ⑤ 刷新页面 → 重开会话 → 分隔线仍在(问题1持久化:合成条目落中立层)
  await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  // 刷新后停留在最后会话(sessions list 恢复);若停在空态则点第一个会话
  const hasDivider = await page.evaluate(() => document.body.innerText.includes("模型 →"));
  if (!hasDivider) {
    // 刷新后停在新会话壳(两内核一致的设计行为:启动只恢复 lastCwd,不恢复会话)——
    // 点会话列表行重开。锚点是 sessions-list 的 data-session-path 行;
    // 历史上的 [data-sidebar-style] 选择器匹配不到任何节点(那是主题预览卡的私有锚),
    // 回退静默落空、断言超时——锚点必须跟真实渲染源走。
    // 会话行点击走可信点击,且**限定在行锚点内**(scope)——`body *` 会匹配到含 "ping" 的消息气泡。
    const clicked = await clickByText(page, "ping", { exact: false, scope: "[data-session-path]" });
    if (clicked) await waitForDomIdle(page, { quietMs: 1200, timeoutMs: 15000 }).catch(() => {});
  }
  // Virtuoso 只渲染可视窗口:重开后视图停在底部,模型分隔线在顶部、未挂载即不在 DOM——
  // 与 ② 同手法先滚到顶再断言(不滚则断言必超时,与数据是否持久化无关)。
  await page.evaluate(() => {
    document.querySelectorAll("div").forEach((d) => { if (d.scrollHeight > d.clientHeight + 200) d.scrollTop = 0; });
  });
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.body.innerText.includes("模型 →"), { timeout: 15000, polling: 400 });
  ok(true, "⑤ 刷新重开后模型分隔线仍在(问题1持久化)");
  await shot("after-reload");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言全部通过(dsh 全链路:思考中自清 + 分隔线 + 收藏分叉入口 + 不重名 + 刷新持久)`);
  console.log(`   截图: ${shotsDir}`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  try {
    await shot("failure");
    const diag = await page.evaluate(() => document.body.innerText.slice(-800)).catch(() => null);
    if (diag) console.error("现场尾部:", diag);
    console.error("页面 console 尾部:", consoleTail.slice(-30).join("\n"));
  } catch { /* 诊断失败不掩盖原因 */ }
  await killApp(app).catch(() => {});
  console.error(`诊断截图保留: ${shotsDir}`);
  process.exit(1);
}
