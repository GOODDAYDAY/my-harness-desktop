#!/usr/bin/env node
// composer 模型固定 e2e（#17：发送之后输入框的模型不该变）+ 一条**关于守卫本身**的实证。
//
// 用户报的现象：「发送之后，输入框的模型没有固定」。
// 根因（已修）：composer 的模型显示要经过一条四级链
//   pending(点选意图，**按 sessionKey 存**) → headerPrefs(中立层头域) → fallbackModel(应用默认) → models[0]
// 而新会话在发出前用的是**乐观 key**（`new:<cwd>`），sessionStart 之后才换成真 ns ——
// 键一漂，第一级的点选意图就查不到，显示顺着链往下掉到"应用默认/清单首项"。
// 修法：`ui-store.carrySessionKey(oldKey, newKey)` 在 hydrateSessionStart 翻键那一刻整体搬迁。
//
// ⚠ **为什么这条守卫必须配两个模型**（本轮实测踩出来的）：
//   我第一版把断言加在了 `minimal-smoke`（隔离 HOME 里 minimal 只有内置 `echo` 一个模型），
//   然后把 `carrySessionKey` 删掉做红证 —— **断言照样绿** ✗。
//   因为键漂了之后显示掉到 `models[0]`，而那里**恰好还是同一个模型**：现象不可观测。
//   「一个模型的环境里测模型漂移」= 尺子量不出要量的东西。所以本文件刻意种**两个**模型，
//   并把**应用默认**设成与所选不同的那个（alpha），点选 beta —— 只有这时"漂回默认"才看得见。
//
// 零 token：模型指向一个不存在的本地端口，发送必然失败；本测试**不依赖回复**，
// 只需要 sessionStart 发生（那正是翻键的时刻）。
//
// 用法: npm run build && node scripts/demo/composer-model-pin.e2e.mjs [--port 9361] [--keep]

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp, assertPortFree } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const args = Object.fromEntries(process.argv.slice(2).flatMap((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [[m[1], m[2] ?? true]] : [];
}));

const PORT = Number(args.port) > 0 ? Number(args.port) : 9361;

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

// 两个模型 + 默认指向第一个：只有"默认 ≠ 所选"时，键漂导致的回退才可观测。
// baseURL 指向一个没人听的端口 —— 发送必然失败，但 sessionStart 该发生的照常发生。
const minimalDir = join(home, ".minimal", "agent");
mkdirSync(minimalDir, { recursive: true });
writeFileSync(join(minimalDir, "models.json"), JSON.stringify({
  providers: [{ id: "mock", name: "Mock", baseURL: "http://127.0.0.1:9/v1", models: [
    { id: "alpha", name: "Mock Alpha" },
    { id: "beta", name: "Mock Beta" },
  ] }],
  default: { provider: "mock", model: "alpha" },
}, null, 2));

await assertPortFree(PORT);
const app = await launchApp({ appDir: ROOT, port: PORT, env: { HOME: home, MHD_PORT: "18465" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 前置：两个模型都在清单里（否则本测试量不出东西）
  await page.click("[data-timeline-composer]");
  const triggerRect = await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const scope = ta?.closest("form") ?? document.body;
    const trigger = [...scope.querySelectorAll("button")].find((b) => {
      const t = (b.textContent || "").trim();
      return b.querySelector("svg") && t.length > 2 && !/^(off|minimal|low|medium|high|xhigh)$/i.test(t);
    });
    const r = trigger.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(triggerRect.x, triggerRect.y);
  // best-effort settle（r124 标注，同族判定见 minimal-smoke r123）：等右键/溢出菜单展开，
  // 只为让后续对菜单项的采样稳定；菜单真没出来时，下面对**菜单项**的断言会自己红。
  await page.waitForSelector("[role='menu']", { timeout: 5000 }).catch(() => {});
  // 多内核时下拉先按内核分 TAB（隔离 HOME 里 pi 的真实清单也在），先点 minimal TAB。
  // 单内核（只有 minimal）时没有 TAB，点了也白点——所以是**条件式**，不硬断言 TAB 存在。
  const tabRect = await page.evaluate(() => {
    const menu = document.querySelector("[role='menu']");
    const tab = [...(menu?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim().toLowerCase() === "minimal");
    if (!tab) return null;
    const r = tab.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (tabRect) {
    await page.mouse.click(tabRect.x, tabRect.y);
    await new Promise((r) => setTimeout(r, 200));
  }
  const itemRects = await page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll("[role^='menuitem']")) {
      const t = (el.textContent || "").trim();
      const r = el.getBoundingClientRect();
      if (r.width > 0) out[t.includes("Beta") ? "beta" : t.includes("Alpha") ? "alpha" : t] = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return out;
  });
  if (!itemRects.alpha || !itemRects.beta) {
    // 失败时把现场端出来（菜单开没开、里面有什么）——别让人对着"没找到"猜。
    const diag = await page.evaluate(() => {
      const menu = document.querySelector("[role='menu']");
      return {
        menuOpen: !!menu,
        menuText: (menu?.textContent || "").replace(/\s+/g, " ").slice(0, 200),
        items: [...document.querySelectorAll("[role^='menuitem']")].map((el) => (el.textContent || "").trim()),
        composerModel: document.querySelector("[data-composer-model]")?.dataset.composerModel ?? "",
      };
    });
    throw new Error(`清单里没找到两个模型：${JSON.stringify(diag)}`);
  }
  ok(true, "清单里有两个模型可用（Alpha/Beta）");

  // 点选**非默认**的那个（beta）。
  await page.mouse.click(itemRects.beta.x, itemRects.beta.y);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});
  const before = await page.evaluate(() => document.querySelector("[data-composer-model]")?.dataset.composerModel ?? "");
  ok(before === "minimal:beta", `发送前 composer 显示所选模型（实际 ${before}）`);

  // ⚠ **必须录序列，不能只比前后**（本轮实测踩出来的第二版）：
  //   只比"发送前/发送后"两个采样点时，把 carrySessionKey 删掉**照样绿** ——
  //   因为显示漂回默认后又被中立层头域（headerPrefs，spawn 时已写入所选模型）拉回来了：
  //   **#17 是个瞬态闪烁，不是持续的错误值**。两次采样之间的那一下它自己愈合了。
  //   所以装 MutationObserver，把翻键窗口里**每一次**取值都记下来，逐条断言。
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__modelSeq = [];
    const read = () => document.querySelector("[data-composer-model]")?.dataset.composerModel ?? "";
    w.__modelSeq.push(read());
    const anchor = document.querySelector("[data-composer-model]");
    if (anchor) {
      new MutationObserver(() => w.__modelSeq.push(read())).observe(anchor, { attributes: true, attributeFilter: ["data-composer-model"] });
    }
    // 锚点本身可能被整块重挂（换元素就收不到 attribute 变更）——补一个 rAF 周期采样兜底。
    const tick = () => { w.__modelSeq.push(read()); if (w.__modelSeq.length < 600) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  // 发送 —— 会失败（模型不可达），但**翻键发生在 sessionStart**，这正是被测时刻。
  await page.click("[data-timeline-composer]");
  await page.keyboard.type("pin check");
  const sendRect = await page.evaluate(() => {
    // r120：改用稳定锚点。此前是 button[aria-label^='发送'] || button[aria-label*='发送']——
    //   语言绑定探针，且下一行 b.getBoundingClientRect() 在 b 为 null 时**直接抛**，
    //   所以换 locale 它不是静默失效而是崩溃（比 r118 那两个更响，但也更晚才发现）。
    const b = document.querySelector("[data-composer-send]");
    if (!b) throw new Error("找不到 [data-composer-send]：发送钮锚点缺失（不要退回按 aria-label 文案定位）");
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(sendRect.x, sendRect.y);
  // 等这一轮彻底安静（会话起过、事件走完）——事件驱动，不赌固定 sleep。
  await waitForDomIdle(page, { quietMs: 1500, timeoutMs: 30000 }).catch(() => {});

  const after = await page.evaluate(() => document.querySelector("[data-composer-model]")?.dataset.composerModel ?? "");
  ok(after === "minimal:beta", `发送后终值仍是所选模型（实际 ${after}）`);

  const seq = await page.evaluate(() => (/** @type {any} */ (window)).__modelSeq ?? []);
  const bad = [...new Set(seq.filter((v) => v !== "minimal:beta"))];
  ok(seq.length > 3, `翻键窗口录到了序列（${seq.length} 个采样点）`);
  ok(
    bad.length === 0,
    `翻键全程**一次都没漂**（越界值 ${JSON.stringify(bad)}；#17 复发时这里会出现 minimal:alpha 或 pi:…）`,
  );

  const dataModel = await page.evaluate(() => document.querySelector("[data-composer-model]")?.textContent ?? "");
  ok(dataModel.includes("Beta"), `按钮文案也跟着所选模型（实际「${dataModel}」）`);

  ok(consoleTail.length === 0, `页面零报错（实际 ${consoleTail.length} 条）`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言（composer 模型固定：两个模型 + 默认≠所选，零 token）`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (e) {
  console.error(`\n❌ FAIL: ${e.message}`);
  await killApp(app).catch(() => {});
  console.error(`   现场保留: ${runRoot}`);
  process.exit(1);
}
