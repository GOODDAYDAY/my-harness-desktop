#!/usr/bin/env node
// minimal fork 全链 e2e —— 隔离 HOME + 种 minimal 中立层会话(零 token),打开 → 悬停
// assistant 行 → 点「分叉」→ 确认 → 断言派生新中立会话(derivedFrom.kind=fork +
// pendingSeed 置位 + kernel 归属 minimal)→ 选 Minimal Echo 发送 → 物化 minimal 后端。
// 验的是「分叉归壳」对 minimal 成立 + 派生的 kernel 归属不漂(跟随源 header.kernel)。
// 用法: npm run build && node scripts/demo/minimal-fork.e2e.mjs [--port 9351] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { clickByText } from "./lib/interact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9351" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
// minimal 是**测试专用内核插件**(不再随壳分发):种进隔离 HOME 的用户插件目录才会装载。
seedTestPlugins(ctx.dataRoot);
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

const NS = "ns-fork-min";
const now = Date.now();
const sessionsDir = join(home, ".my-harness-desktop-dev", "sessions");
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(join(sessionsDir, `${NS}.header.json`), JSON.stringify({
  neutralSessionId: NS, rootLineageId: NS,
  header: { kernel: "minimal", cwd: projectDir, createdAt: new Date(now - 60000).toISOString(), name: "minimal 源会话", lastMessage: "答完了。", lastEntryId: `${NS}:1`, updatedAt: new Date(now - 1000).toISOString() },
}));
writeFileSync(join(sessionsDir, `${NS}.entries.json`), JSON.stringify({
  neutralSessionId: NS,
  lineages: [{ lineageId: NS, fork: null, entries: [
    { neutralEntryId: `${NS}:0`, message: { role: "user", content: "问个问题", timestamp: now - 50000 } },
    { neutralEntryId: `${NS}:1`, message: { role: "assistant", content: [{ type: "text", text: "答完了。" }], timestamp: now - 49000 } },
  ] }],
}));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18455" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 打开源会话
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    await page.waitForFunction(() => [...document.querySelectorAll("*")].some((e) => (e.textContent || "").trim() === "minimal 源会话" && e.children.length < 6), { timeout: 15000, polling: 300 });
  // 会话行点击走可信点击(合成 MouseEvent 对 Radix 行点击实测翻车过)。
  if (!(await clickByText(page, 'minimal 源会话', { exact: true }))) throw new Error("未找到会话行: minimal 源会话");
    opened = await page.waitForFunction(() => document.querySelectorAll("[data-message-id]").length > 0, { timeout: 10000, polling: 300 }).then(() => true).catch(() => false);
  }
  if (!opened) {
    // 现场：侧栏有哪些行、消息区有几个行、页面报了什么错 —— 区分"测试点错了"与"应用没打开"。
    const diag = await page.evaluate(() => ({
      sidebarRows: [...document.querySelectorAll("[data-session-path]")].map((el) => (el.textContent || "").replace(/\s+/g, " ").slice(0, 30)),
      messageRows: document.querySelectorAll("[data-message-id]").length,
      composerModel: document.querySelector("[data-composer-model]")?.dataset.composerModel ?? "",
      bodyHead: document.body.innerText.replace(/\s+/g, " ").slice(0, 200),
    }));
    console.error("  诊断(打开失败):", JSON.stringify(diag));
    console.error("  页面报错:", JSON.stringify(consoleTail.slice(0, 3)));
  }
  ok(opened, "打开 minimal 源会话(消息行渲染)");
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 }).catch(() => {});

  // 悬停 assistant 行 → 点「分叉」→ 点「确认分叉?」
  // 事件驱动等目标行落位（**不一次性 evaluate**）：`[data-message-id]` 已出现 ≠ 那条 assistant
  // 已经渲染完（Virtuoso 只渲染可视窗口，行是分批挂上的）。一次性读会偶发拿到 null，
  // 报出来的却是 "Cannot read properties of null (reading 'x')" —— 像代码 bug，其实是尺子抢跑。
  const rowReady = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((r) => (r.textContent || "").includes("答完了。")),
    { timeout: 15000, polling: 200 },
  ).then(() => true).catch(() => false);
  if (!rowReady) throw new Error("等待 assistant 消息行超时（种子会话内容未渲染）");
  const box = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-message-id]")];
    const row = rows.find((r) => (r.textContent || "").includes("答完了。"));
    if (!row) return null;
    row.scrollIntoView({ block: "center" });
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  ok(!!box, "找到 assistant 消息行");
  await page.mouse.move(box.x, box.y);
  await new Promise((r) => setTimeout(r, 700)); // hover 淡入
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").includes("分叉") && !(x.title || "").includes("确认"));
    if (!b) return false;
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  ok(clicked, "点击「分叉」(arm)");
  await new Promise((r) => setTimeout(r, 400));
  const confirmed = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").includes("确认分叉"));
    if (!b) return false;
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  ok(confirmed, "点击「确认分叉?」执行");

  // 等派生会话落盘:derivedFrom.kind=fork + pendingSeed + kernel=minimal
  let derived = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !derived) {
    for (const f of readdirSync(sessionsDir).filter((x) => x.endsWith(".header.json"))) {
      if (f.startsWith(NS)) continue;
      const h = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8"));
      if (h?.header?.derivedFrom?.kind === "fork" && h?.header?.derivedFrom?.sourceNeutralSessionId === NS) {
        derived = { ns: h.neutralSessionId, pendingSeed: h.header.pendingSeed, kernel: h.header.kernel };
        break;
      }
    }
    if (!derived) await new Promise((r) => setTimeout(r, 500));
  }
  ok(!!derived, "派生新中立会话落盘(derivedFrom.kind=fork)");
  ok(derived.pendingSeed === true, "派生会话 pendingSeed 置位");
  ok(derived.kernel === "minimal", `派生会话 kernel 归属 minimal(实际 ${derived.kernel})`);

  // 选 Minimal Echo → 发送 → 物化 minimal 后端(pendingSeed 清除 + echo)。
  const triggerRect = await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const scope = ta?.closest("form") ?? document.body;
    const btns = [...scope.querySelectorAll("button")].filter((b) => b.querySelector("svg"));
    const trigger = btns.find((b) => { const t = (b.textContent || "").trim(); return t.length > 2 && !/^(off|minimal|low|medium|high|xhigh)$/i.test(t); });
    if (!trigger) return null;
    const r = trigger.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(triggerRect.x, triggerRect.y);
  // best-effort settle（r124 标注，同族判定见 minimal-smoke r123）：等右键/溢出菜单展开，
  // 只为让后续对菜单项的采样稳定；菜单真没出来时，下面对**菜单项**的断言会自己红。
  await page.waitForSelector("[role='menu']", { timeout: 4000 }).catch(() => {});
  const tabRect = await page.evaluate(() => {
    const tab = [...document.querySelectorAll("[role='menu'] button")].find((b) => (b.textContent || "").trim().toLowerCase() === "minimal");
    if (!tab) return null;
    const r = tab.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(tabRect.x, tabRect.y);
  // 必须等列表换成目标内核的(点 TAB → Radix 状态更新 → 重渲染是异步的;立刻取样会读到上一个内核的列表)。
  // 同族假失败实测过(minimal-model「Mock 未找到」:tabs 有 minimal 但 items 全是 pi 的)。见 skills §10.3.1。
  await page.waitForFunction(
    () => [...document.querySelectorAll("[role^='menuitem']")].some((el) => (el.textContent || "").includes('Minimal Echo')),
    { timeout: 6000, polling: 200 },
  ).catch(() => {});
  const itemRect = await page.evaluate(() => {
    const item = [...document.querySelectorAll("[role^='menuitem']")].find((el) => (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(itemRect.x, itemRect.y);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});

  await page.click("[data-timeline-composer]");
  await page.keyboard.type("分叉后的消息");
  const sendRect = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label^='发送']") || document.querySelector("button[aria-label*='发送']");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(sendRect.x, sendRect.y);
  // best-effort settle（r124 标注，同族判定见 minimal-smoke r123）：两阶段收敛的第一阶段——
  // 等「停止」出现。零 token / 模型端点不可达的剧本里 streaming 可能**从不开始**，
  // 停止钮合法地不出现，所以等不到不算失败（真失败由『发送后该出现的产物』那些断言报出来）。
  await page.waitForSelector("[data-composer-stop]", { timeout: 20000 }).catch(() => {});
  // best-effort settle（r124 标注，同族判定见 minimal-smoke r123）：两阶段收敛的第二阶段——
  // 等「停止」消失（streaming 收尾）。等不到也继续：后续断言读的是终态 DOM，
  // 若仍在 streaming 会由那些断言报出来，而不是在这里静默吞掉一个『没收尾』的信号。
  await page.waitForFunction(() => !document.querySelector("[data-composer-stop]"), { timeout: 30000, polling: 500 }).catch(() => {});
  const echoed = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("[minimal echo] 分叉后的消息")),
    // 与 minimal-smoke 的同类等待同源：这条前面已经耗掉两阶段收敛（各 20s/30s 且**失败会被吞**），
    // 冷启动 + 模型加载会让 10s 预算在真没问题时也等不到 → **失败信息指向错误的组件**。
    // 放宽到 45s 只影响"等多久才判失败"，不影响任何被测行为。
    { timeout: 45000, polling: 300 },
  ).then(() => true).catch(() => false);
  if (!echoed) {
    // 失败时把现场端出来：DOM 里有什么、页面报了什么错 —— 别让人对着"echo 没出现"猜。
    const diag = await page.evaluate(() => ({
      composerModel: document.querySelector("[data-composer-model]")?.dataset.composerModel ?? "",
      messages: [...document.querySelectorAll("[data-message-id]")].map((el) => (el.textContent || "").replace(/\s+/g, " ").slice(0, 60)),
      busy: !!document.querySelector("[data-composer-stop]"),
    }));
    console.error("  诊断(页面):", JSON.stringify(diag));
    console.error("  页面报错:", JSON.stringify(consoleTail.slice(0, 3)));
    // 中立层 vs 内核文件对账：这条链路的失败**十有八九不在 DOM**，而在"内核写了、中立层没落"。
    // 把两侧的条目与 kernelEntryId 都打出来，一次就能看出是不是被幂等跳过（本轮实测就这么定位的）。
    try {
      const ne = JSON.parse(readFileSync(join(sessionsDir, `${derived.ns}.entries.json`), "utf-8"));
      console.error("  诊断(中立层):", ne.lineages.map((l) => l.entries.map((e) => `${e.message.role}/${(e.kernelEntryId ?? "-").slice(0, 8)}`).join(" | ")).join(" || "));
      const kf = join(home, ".minimal", "agent", "sessions");
      const found = [];
      for (const bucket of readdirSync(kf)) for (const f of readdirSync(join(kf, bucket))) if (f.endsWith(".jsonl")) found.push(join(kf, bucket, f));
      for (const f of found) {
        const rows = readFileSync(f, "utf-8").split("\n").filter((x) => x.includes('"message"'));
        console.error("  诊断(内核文件):", rows.map((r) => { const e = JSON.parse(r); return `${e.message.role}/${String(e.id).slice(0, 8)}`; }).join(" | "));
      }
    } catch (e) { console.error("  诊断(对账失败):", String(e).slice(0, 120)); }
  }
  ok(echoed, "派生会话首发物化 + echo(分叉→物化链路通)");

  // 物化后 pendingSeed 清除 + minimal 文件落盘。
  const afterHeader = JSON.parse(readFileSync(join(sessionsDir, `${derived.ns}.header.json`), "utf-8"));
  ok(afterHeader.header.pendingSeed !== true, "物化后 pendingSeed 清除");
  const minimalDir = join(home, ".minimal", "agent", "sessions");
  const minimalFiles = existsSync(minimalDir) ? readdirSync(minimalDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")) : [];
  ok(minimalFiles.length > 0, "派生会话 minimal 文件落盘(.minimal/)");

  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条)`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(minimal fork=派生新会话 + kernel 归属 + 物化)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
