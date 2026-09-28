#!/usr/bin/env node
// 「删掉内核插件之后，已开的那个内核会话怎么样」—— §3.6.2 语义 2 与 §7.6 显式降级的
// **用户可见证据**（boot-surface.md §6.4.3 验收②里此前未断言的部分）。
//
// 为什么单独立一个剧本：`kernel-reload.e2e.mjs` 验的是"重载机制本身对不对"（差量清单、
// 注册表、renderer 清单与三张映射）。本剧本验的是**用户会看到什么**——而这条链上有一个
// r19 才修掉的真实缺口：会话行的 `kernelLoaded` 是 main 侧按当时注册表算好下发的，
// 内核重载后 main 侧立刻算对了（r16 起是活 getter），但 renderer 手里的 `sessionInfos`
// 还是旧旗标，于是**角标与只读条都不出现**，用户点发送要到服务端才被拒
// （而 `application/sessions/session-store.ts:502` 的注释明写"正常 UI 路径走不到这里"）。
// 修法是让框架的 sessionInfos 拉取口也订阅中性 `refresh.requested`（§3.3 框架管通用）。
//
// 「已开的会话仍能继续」按代码里的原话理解，不凭印象：
//   `sessions/timeline/renderer/index.tsx:492`——「会话记录的内核**没装载**(§7.6 显式降级):
//   这一行仍**可读**(内容在中立层),但发不出去。」
// 所以断言的是"仍可打开、历史仍在"，而不是"还能发新消息"（内核都没了，发不出去是**正确**行为）。
//
// 零 token：全程用 minimal（echo 内核）。
//
// 用法: npm run build && node scripts/demo/kernel-unload-session.e2e.mjs [--port 9370] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { clickPointUntil } from "./lib/interact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9370" }, keep: { type: "boolean", default: false } } });

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
const seeded = seedTestPlugins(ctx.dataRoot);
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(ctx.configDir, "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));
const minimalDir = seeded[0];

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18467" }, timeoutMs: 90000 });
const page = app.page;
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const PROMPT = "删内核前先在 minimal 上留一段历史";

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // ---- 第一步：切到 minimal 并发一条，造出一个"归属 minimal 的会话" ----
  console.log("\n── 第一步：在 minimal 上造一个会话 ──");
  // ⚠ 必须**可信点击**（page.mouse.click 走 CDP 注入真实输入），不能用
  //   page.evaluate(() => el.click()) 的合成事件：Radix 的菜单不认合成点击（skill §3.2）。
  const trigRect = await page.evaluate(() => {
    const b = document.querySelector("button[data-composer-model]");
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(trigRect.x, trigRect.y);
  await page.waitForSelector("[role='menu']", { timeout: 8000 });
  const switched = await clickPointUntil(
    page,
    () => {
      const tab = [...document.querySelectorAll("[role='menu'] button")].find((b) => (b.textContent || "").trim().toLowerCase() === "minimal");
      if (!tab) return null;
      const r = tab.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    () => [...document.querySelectorAll("[role^='menuitem']")].some((el) => (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0),
  );
  ok(switched, "切到 minimal TAB 并列出它的模型");
  const itemRect = await page.evaluate(() => {
    const it = [...document.querySelectorAll("[role^='menuitem']")].find((el) => (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0);
    const r = it.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(itemRect.x, itemRect.y);
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 12000 }).catch(() => {});
  ok(String(await page.evaluate(() => document.querySelector("[data-composer-model]")?.getAttribute("data-composer-model"))).startsWith("minimal:"),
    "composer 已绑到 minimal");

  await page.click("[data-timeline-composer]");
  await page.keyboard.type(PROMPT);
  const sendRect = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label*='发送']");
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(sendRect.x, sendRect.y);
  // ⚠ waitForFunction 的签名是 (fn, **options**, ...args)——options 在第二位（skill §17.11）
  const echoed = await page.waitForFunction(
    (p) => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(`[minimal echo] ${p}`)),
    { timeout: 60000, polling: 500 },
    PROMPT,
  ).then(() => true).catch(() => false);
  ok(echoed, "minimal 的 echo 回复到达（会话历史已落中立层）");
  const cardsBefore = await page.evaluate(() => document.querySelectorAll("[data-message-id]").length);
  console.log(`  · 删除前消息卡 ${cardsBefore} 张`);

  // 起点状态：不该有任何"未装载"标记
  const before = await page.evaluate(() => ({
    unloadedBadges: document.querySelectorAll("[data-session-kernel-unloaded]").length,
    readonlyBars: document.querySelectorAll("[data-composer-readonly]").length,
  }));
  ok(before.unloadedBadges === 0 && before.readonlyBars === 0, `起点干净（角标 ${before.unloadedBadges}、只读条 ${before.readonlyBars}）`);

  // ---- 第二步：删掉 minimal 插件目录并重载 ----
  console.log("\n── 第二步：删插件目录 → 重载 ──");
  rmSync(minimalDir, { recursive: true, force: true });
  ok(!existsSync(minimalDir), "插件目录已删（卸载 = 删目录）");
  const report = await page.evaluate(() => window.kernel.reloadKernels());
  console.log(`  · 重载返回：removed=${JSON.stringify(report.kernels.removed)} unchanged=${JSON.stringify(report.kernels.unchanged)} errors=${report.kernels.errors.length}`);
  ok(report.kernels.removed.join() === "minimal", "minimal 被识别为已移除");
  // 等 renderer 重拉 sessionInfos（框架订阅了 refresh.requested → loadForCwd）
  await page.waitForFunction(() => document.querySelectorAll("[data-session-kernel-unloaded]").length > 0, { timeout: 20000, polling: 400 })
    .catch(() => {});
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});

  // ---- 第三步：用户可见的三件事 ----
  console.log("\n── 第三步：用户看到什么 ──");
  const after = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-session-path]")];
    const badgeRow = rows.find((r) => r.querySelector("[data-session-kernel-unloaded]"));
    const bar = document.querySelector("[data-composer-readonly]");
    return {
      rowCount: rows.length,
      badgeCount: document.querySelectorAll("[data-session-kernel-unloaded]").length,
      badgeText: badgeRow ? (badgeRow.querySelector("[data-session-kernel-unloaded]").getAttribute("title")
        || badgeRow.querySelector("[data-session-kernel-unloaded]").textContent || "").trim().slice(0, 60) : null,
      badgeRowText: badgeRow ? (badgeRow.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) : null,
      readonlyReason: bar ? bar.getAttribute("data-composer-readonly") : null,
      readonlyText: bar ? (bar.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90) : null,
      composerGone: !document.querySelector("[data-timeline-composer]"),
      cards: document.querySelectorAll("[data-message-id]").length,
      cardTexts: [...document.querySelectorAll("[data-message-id]")].map((c) => (c.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40)),
    };
  });
  console.log(`  · 会话行 ${after.rowCount} 个，未装载角标 ${after.badgeCount} 个`);
  console.log(`  · 角标所在行：${JSON.stringify(after.badgeRowText)}`);
  console.log(`  · 只读条 reason=${JSON.stringify(after.readonlyReason)} 文案=${JSON.stringify(after.readonlyText)}`);
  console.log(`  · composer 已被替换=${after.composerGone}；消息卡 ${after.cards} 张（删除前 ${cardsBefore}）`);

  ok(after.badgeCount > 0, "会话行出现「内核未装载」角标（data-session-kernel-unloaded）");
  ok(after.readonlyReason === "kernel-not-loaded", `输入框被只读条替换，且原因是 kernel-not-loaded（实际 ${JSON.stringify(after.readonlyReason)}）`);
  ok(after.composerGone, "composer 输入框确实不在了（不是『能输入但发送时才报错』）");
  ok(after.cards === cardsBefore && after.cards > 0, `历史仍完整可读（${after.cards} 张卡，与删除前一致）—— 内容在中立层，与内核是否在册无关`);
  ok(after.cardTexts.some((t) => t.includes(PROMPT.slice(0, 10))), "删除前那条提问仍看得见");
  ok(after.cardTexts.some((t) => t.includes("[minimal echo]")), "删除前的 echo 回复仍看得见");

  // logo：last-known 语义（已在册过的内核，卸载后仍返回 logo，正在跑的会话不该丢图标）
  const logoStill = await page.evaluate(() => window.kernel.kernelLogos.get("minimal").then((l) => !!l).catch(() => false));
  ok(logoStill, "已卸载内核的 logo 仍取得到（last-known 语义）");
  // 而从未在册的 id 必须是 undefined（renderer 回落占位），不能伪造
  const ghostLogo = await page.evaluate(() => window.kernel.kernelLogos.get("never-existed").then((l) => l === undefined || l === null).catch(() => true));
  ok(ghostLogo, "从未在册的内核 id → logo 为空（不伪造）");

  // ⚠ 这里原本有一条"绕过 UI 直接发送应被服务端拒绝"的检查，**已删除**，两个原因：
  //   ① 它是**空断言**：写的是 `window.kernel.sessions.sendPrompt?.(...)`，而这个方法在契约里
  //      根本不存在（`packages/react/src/index.ts` 查无此名），`?.` 让调用变成 undefined，
  //      于是无论服务端拦不拦都得到 "no-throw" —— 正是 skill §17.2 第 7 种假绿。
  //   ② 它的前提是**错的**：服务端**有意不拦**这条路径。`application/sessions/session-store.ts:498-505`
  //      的注释写明——调用方传的 kernel 是"模型的派生量"，在服务端再拦一道会把
  //      "用户显式换模型换内核"这条合法路径也一起拦掉（既有用例：三会话 pi/dsh 来回切、
  //      fork dsh→切 pi）；**显式降级是渲染层的职责**（会话行角标 + 输入框只读条）。
  //   所以正确的断言就是上面那条 `composerGone`：UI 层面根本发不出去。
  //   服务端侧的相关行为另有单测守着（session-store.test.ts:2084/2090：一行内核未装载时
  //   其余行照常返回、且那一行不丢——退回中立 id 作为投影地址）。
  console.log("  · 服务端有意不拦这条路径（降级是渲染层职责，见 session-store.ts:498-505）；已断言 composer 不存在");

  ok(pageErrors.length === 0, `页面零报错（实际 ${pageErrors.length} 条${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ").slice(0, 160) : ""}）`);
} finally {
  await killApp(app);
}

console.log(`\n✅ PASS: ${passed} 项断言（删内核插件后：角标 + 只读条 + 历史仍可读 + last-known logo）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
