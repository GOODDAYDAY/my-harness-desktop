#!/usr/bin/env node
// minimal 内核冒烟 e2e —— 隔离 HOME + 种 lastCwd,真 app 里验:
// 1) 应用拉起无崩溃;2) 模型下拉出现「Minimal Echo」(minimal 内核的模型已合流进模型清单)。
// 零 token(不发送)。这是 minimal 成为第三个同级内核的第一道真 app 证据(后续再验发送链路)。
// 用法: npm run build && node scripts/demo/minimal-smoke.e2e.mjs [--port 9350] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
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
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9350" }, keep: { type: "boolean", default: false }, kernel: { type: "string", default: "minimal" } } });

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

// ── 参数化：同一个剧本验**任意一个**自包含测试内核（r48）──
//
// 为什么参数化而不是复制一份 probe4 剧本：要证明的命题是「第四内核与 minimal **同等地位、
// 同等功能**」（诉求 7/9）。复制一份近似剧本只能证明"probe4 也跑得通"；
// **同一个剧本、同一组判据、只换一个 id** 才证明两者走同一条路径、享受同一套契约。
// 这也是 electron.vite.config.ts 那条承诺的实测：「加第四个内核 = 加一个目录（含 plugin.ts），
// 本文件零改动」——除了壳侧零改动，**验证脚本也零改动**（只加一行配置）。
const KERNELS = {
  // systemPrompt: 该内核是否承接「追加系统 prompt」（BackendCapabilities.systemPrompt）。
  //   两个测试内核都不承接（只有 pi 的 backend-factory 消费 systemPromptPaths/Texts，
  //   取证见 docs/add-new-kernel.md §4.2 与 src/system-prompt-asymmetry.test.ts）。
  minimal: { id: "minimal", tab: "minimal", model: "Minimal Echo", echo: "[minimal echo]", hello: "你好 minimal", second: "第二条消息", systemPrompt: false },
  probe4:  { id: "probe4",  tab: "probe4",  model: "Probe4 Echo",  echo: "[probe4 echo]",  hello: "你好 probe4",  second: "第二条消息", systemPrompt: false },
};
const K = KERNELS[args.kernel];
if (!K) throw new Error(`未知 --kernel=${args.kernel}（可选：${Object.keys(KERNALS).join(" / ")}）`);
console.log(`  · 目标内核：${K.id}（TAB=${K.tab}、模型=${K.model}、回声=${K.echo}）`);

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18459" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  // ⚠ 页内闭包**读不到** Node 侧的 K（r34 踩过：locate 里用了闭包变量，异常被 .catch 吞掉，
  //   表现为"点了但没反应"）。一次性注入成 window 全局，后面所有 evaluate 直接读它。
  await page.evaluate((k) => { window.__K = k; }, K);
  ok(true, "应用拉起,composer 就绪");

  // 打开模型下拉:composer 内带 svg 的按钮(排除思考档位),用真实 CDP 鼠标点(§3.2 可信点击)。
  const triggerRect = await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const scope = ta?.closest("form") ?? document.body;
    const btns = [...scope.querySelectorAll("button")].filter((b) => b.querySelector("svg"));
    // 触发器文本 = 当前模型名(长度>2),排除思考档位(off/minimal/low/medium/high/xhigh)。
    const trigger = btns.find((b) => {
      const t = (b.textContent || "").trim();
      return t.length > 2 && !/^(off|minimal|low|medium|high|xhigh)$/i.test(t);
    });
    if (!trigger) return null;
    const r = trigger.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!triggerRect) throw new Error("未找到模型下拉触发器");
  await page.mouse.click(triggerRect.x, triggerRect.y);
  await page.waitForSelector("[role='menu']", { timeout: 4000 }).catch(() => {});
  ok(!!(await page.evaluate(() => !!document.querySelector("[role='menu']"))), "模型下拉已打开");

  // 点「minimal」内核 TAB(真实鼠标)。
  // 内核 TAB 用**有界重试点击**：菜单刚打开时还在动画，一次性取的坐标会打偏
  // （现场表现为"点了没反应 → 模型没合流"，看着像插件坏了）。每次重试重新算坐标。
  const tabClicked = await clickPointUntil(
    page,
    () => {
      const menu = document.querySelector("[role='menu']");
      const tab = [...(menu?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim().toLowerCase() === window.__K.tab);
      if (!tab) return null;
      const r = tab.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    () => {
      // 判据：点完之后「Minimal Echo」这一项真的在菜单里可见
      return [...document.querySelectorAll("[role^='menuitem']")].some((el) => (el.textContent || "").includes(window.__K.model) && el.getBoundingClientRect().width > 0);
    },
  );
  if (!tabClicked) {
    const tabs = await page.evaluate(() => {
      const menu = document.querySelector("[role='menu']");
      return [...(menu?.querySelectorAll("button") ?? [])].map((b) => (b.textContent || "").trim()).filter(Boolean);
    });
    throw new Error(`${K.tab} TAB 点了 ${6} 次仍没让模型项出现(实际 TAB: ${JSON.stringify(tabs)})`);
  }
  ok(true, `已点击 ${K.tab} 内核 TAB`);

  // 查「Minimal Echo」(role=menuitem,文本含显示名)。
  const hasMinimal = await page.waitForFunction(
    () => [...document.querySelectorAll("[role^='menuitem']")].some((el) => (el.textContent || "").includes(window.__K.model)),
    { timeout: 8000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(hasMinimal, `模型下拉出现「${K.model}」(${K.id} 内核模型已合流)`);

  // 选「Minimal Echo」→ 发消息 → 验证 echo 出现在时间线。
  const itemRect = await page.evaluate(() => {
    const item = [...document.querySelectorAll("[role^='menuitem']")].find((el) =>
      (el.textContent || "").includes(window.__K.model) && el.getBoundingClientRect().width > 0);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!itemRect) throw new Error("「Minimal Echo」模型项不可点");
  await page.mouse.click(itemRect.x, itemRect.y);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});
  ok(true, `已选「${K.model}」`);

  // composer 模型锚点渲染（**只验"渲染出来了"，不验"发送后固定"**）。
  // #17 的守卫**不在这里**：本 HOME 只把 minimal 的 `echo` 一个模型摆上台，
  // 键漂之后显示掉到的"清单首项/应用默认"**恰好还是同一个模型**，现象不可观测
  // （实测：删掉修复这条断言照样绿 —— 假守卫）。真守卫在 `composer-model-pin.e2e.mjs`：
  // 那里种两个模型 + 默认≠所选 + MutationObserver 录序列，能抓到瞬态闪烁。
  const modelBefore = await page.evaluate(() => document.querySelector("[data-composer-model]")?.textContent ?? "");
  ok(modelBefore.length > 0, `发送前 composer 渲染出模型(${modelBefore})`);

  // 发消息(真实键盘)。
  await page.click("[data-timeline-composer]");
  await page.keyboard.type(K.hello);
  const sendRect = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label^='发送']") || document.querySelector("button[aria-label*='发送']");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!sendRect) throw new Error("未找到发送按钮");
  await page.mouse.click(sendRect.x, sendRect.y);

  // 两阶段收敛(§3.4):先等「停止」起跑,再等「停止」消失。
  await page.waitForSelector("[data-composer-stop]", { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("[data-composer-stop]"), { timeout: 30000, polling: 500 }).catch(() => {});
  const echoed = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(window.__K.echo + " " + window.__K.hello)),
    // ⚠ 这条是整条链上**唯一不吞超时、且最紧**的预算(第 241/242 轮定位):
    //   前面两阶段收敛(等停止起跑/消失)最多可耗 20s+30s,且**失败会被吞**,
    //   于是"这一轮跑得久"(冷启动+模型加载)会让本行在 10s 内等不到 echo →
    //   报出"端到端发送链路不通" ✗ —— **失败信息指向了错误的组件**。
    //   故把预算放宽到 45s(仍是等待、不是 sleep):它只影响"等多久才判失败",
    //   不影响任何被测行为 ✓。真正的就绪问题仍会由它如实报出 ✓。
    { timeout: 45000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(echoed, `时间线出现 ${K.echo} 回复(端到端发送链路通)`);

  // 发送后锚点仍在、且仍渲染同一个模型（弱断言，理由见上；#17 的强守卫在专用 e2e）。
  const modelAfter = await page.evaluate(() => document.querySelector("[data-composer-model]")?.textContent ?? "");
  ok(modelAfter.length > 0, `发送后 composer 仍渲染模型(${modelAfter})`);

  // ── #19「新建的会话没有在左侧展示」的真判据 ──
  // 此前只有 orphan-kernel 那条 e2e 验"点了 + 之后**原会话**还在"——那不是用户报的事。
  // 用户报的是：**新建一个会话、发了消息，左栏里没有它**。
  // 判据必须落在"这个新会话本身出现了"，而不是"列表没崩"。
  const sidebar = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-session-path]")];
    return {
      count: rows.length,
      texts: rows.map((r) => (r.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40)),
    };
  });
  ok(
    sidebar.count >= 1 && sidebar.texts.some((t) => t.includes(K.hello)),
    `新建的会话出现在左栏（${sidebar.count} 行：${JSON.stringify(sidebar.texts)}）`,
  );

  // 文件对应守卫:中立层 header.kernel=minimal,且 minimal 会话文件落 .minimal/(非 .pi/)。
  const neutralDir = join(home, ".my-harness-desktop-dev", "sessions");
  const headers = readdirSync(neutralDir).filter((f) => f.endsWith(".header.json"));
  const latestHeader = headers.sort().map((f) => JSON.parse(readFileSync(join(neutralDir, f), "utf-8"))).pop();
  ok(latestHeader?.header?.kernel === K.id, `中立层 header.kernel = ${K.id}`);
  ok(latestHeader?.header?.custom?.model?.kernel === K.id, `中立层 model 域 kernel = ${K.id}`);
  // ⚠ 路径按**内核 id 派生**：每个内核有自己的数据根（`~/.<id>/agent/sessions`），
  //   写死 `.minimal` 会让参数化后的 probe4 跑这条断言必然失败（r48 实踩）。
  const minimalDir = join(home, `.${K.id}`, "agent", "sessions");
  const minimalFiles = existsSync(minimalDir) ? readdirSync(minimalDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")) : [];
  ok(minimalFiles.length > 0, `${K.id} 会话文件落在 .${K.id}/agent/sessions/`);
  const piDir = join(home, ".pi", "agent", "sessions");
  const piJsonl = existsSync(piDir) ? readdirSync(piDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")) : [];
  ok(piJsonl.length === 0, `pi 目录无 ${K.id} 会话文件(实际 ${piJsonl.length} 个)`);

  // 第二轮发送(多轮长交互):验证 append 路径(第二条走 appendFileSync,非首条 header 写)。
  await page.click("[data-timeline-composer]");
  await page.keyboard.type(K.second);
  await page.mouse.click(sendRect.x, sendRect.y);
  await page.waitForSelector("[data-composer-stop]", { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("[data-composer-stop]"), { timeout: 30000, polling: 500 }).catch(() => {});
  const echoed2 = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(window.__K.echo + " " + window.__K.second)),
    { timeout: 10000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(echoed2, "第二轮 echo 出现(多轮 append 路径通)");

  // DOM 组装顺序对账(§3.3 线性序):消息卡片按 user→assistant→user→assistant 顺序渲染。
  const orderOk = await page.evaluate(() => {
    const texts = [...document.querySelectorAll("[data-message-id]")].map((el) => (el.textContent || "").replace(/\s+/g, " "));
    const i1 = texts.findIndex((t) => t.includes(window.__K.hello));
    const i2 = texts.findIndex((t) => t.includes(window.__K.echo + " " + window.__K.hello));
    const i3 = texts.findIndex((t) => t.includes("第二条消息"));
    const i4 = texts.findIndex((t) => t.includes(window.__K.echo + " " + window.__K.second));
    return i1 >= 0 && i1 < i2 && i2 < i3 && i3 < i4;
  });
  ok(orderOk, "消息卡片按 user→assistant→user→assistant 顺序组装(线性序不混)");

  // minimal 会话文件格式对账(§3.3):头行 type=session,消息条目 type=message,共 4 条(2 user + 2 assistant)。
  const minimalFilePath = join(minimalDir, ...minimalFiles[0].split("/"));
  const lines = readFileSync(minimalFilePath, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  ok(lines[0].type === "session", `${K.id} 文件头行 type=session`);
  const msgLines = lines.filter((l) => l.type === "message");
  ok(msgLines.length === 4, `${K.id} 文件 message 条目 = 4(实际 ${msgLines.length})`);
  ok(msgLines.every((l) => l.message && typeof l.message.role === "string"), "每条 message 条目都含 message.role(格式对应)");
  const userCount = msgLines.filter((l) => l.message.role === "user").length;
  const asstCount = msgLines.filter((l) => l.message.role === "assistant").length;
  ok(userCount === 2 && asstCount === 2, `user=2 / assistant=2(实际 user=${userCount} assistant=${asstCount})`);

  // 重开会话:⌘N 新会话 → 回点 minimal 会话行 → 消息仍在 → 第三条续跑。
  await page.keyboard.down("Meta"); await page.keyboard.press("n"); await page.keyboard.up("Meta");
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 6000 }).catch(() => {});
  const emptyAfterNew = await page.evaluate(() => document.querySelector("[data-timeline-composer]")?.value ?? null);
  ok(emptyAfterNew === "", `⌘N 新会话输入框空(实际「${emptyAfterNew}」)`);

  const rowRect = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-session-path]")];
    const row = rows.find((r) => (r.textContent || "").includes(window.__K.hello));
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  if (!rowRect) throw new Error(`未找到 ${K.id} 会话行(${K.hello})`);
  await page.mouse.click(rowRect.x, rowRect.y);
  // 两阶段收敛(skills §3.3 Virtuoso 只渲染可视窗口 / §3.4 收敛必须两阶段):
  // 先等"有任何消息"落位,再等**目标那条**进 DOM。此前是「泛等一下就一次性取样」
  // ——泛条件先满足时目标那条可能还没进 DOM,产生间歇假红(实测约 2 次 1 次)。
  await page.waitForFunction(() => document.querySelectorAll("[data-message-id]").length > 0, { timeout: 10000, polling: 300 }).catch(() => {});
  const reopened = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(window.__K.echo + " " + window.__K.second)),
    { timeout: 10000, polling: 300 },
  ).then(() => true).catch(() => false);
  if (!reopened) {
    // 失败时留证据:区分「全空」(真 bug)与「有消息但没这条」(渲染窗口/内容问题)。
    const dump = await page.evaluate(() => ({
      n: document.querySelectorAll("[data-message-id]").length,
      texts: [...document.querySelectorAll("[data-message-id]")].map((e) => (e.textContent || "").trim().slice(0, 20)),
    }));
    console.log(`   [诊断] 重开后消息数=${dump.n} 文本=${JSON.stringify(dump.texts)}`);
  }
  ok(reopened, "重开后历史消息仍在(中立层读路径通)");

  // 第三条续跑(重开后重新 seed minimal 后端再发)。
  await page.click("[data-timeline-composer]");
  await page.keyboard.type("第三条续跑");
  await page.mouse.click(sendRect.x, sendRect.y);
  await page.waitForSelector("[data-composer-stop]", { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("[data-composer-stop]"), { timeout: 30000, polling: 500 }).catch(() => {});
  const echoed3 = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(window.__K.echo + " 第三条续跑")),
    { timeout: 10000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(echoed3, "重开后第三条 echo 出现(续跑链路通)");

  // 收尾文件对账:重开后 minimal 文件仍含第三条(重开未换文件、未丢内容)。
  const finalLines = readFileSync(minimalFilePath, "utf-8");
  ok(finalLines.includes("第三条续跑"), `重开后 ${K.id} 文件含第三条消息(同文件续写)`);

  // ── 显式降级：贡献 systemPrompts 的插件在不承接的内核下必须**说出来**（r50）──
  //
  // 背景：`systemPromptPaths/Texts` 由 application 层中性地注入给每个内核，但只有 pi 消费；
  // `goody-hao` 插件贡献 systemPrompts 槽，于是它在 pi 下真注入、在其它内核下**静默不生效**
  // ——而插件行照常显示"已启用"、描述照常承诺注入，用户没有任何线索（§1.5 禁止的「静默缺面」）。
  // 修法：加 `BackendCapabilities.systemPrompt` 轴 + 插件管理页据此明示。这段验它真的显示出来。
  console.log("\n── 插件页的 systemPrompts 降级提示 ──");
  await page.evaluate(() => document.querySelector('[data-sidebar-entry="settings"]')?.click());
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 12000 }).catch(() => {});
  await page.evaluate(() => [...document.querySelectorAll("[data-settings-id]")].find((x) => x.getAttribute("data-settings-id") === "plugins")?.click());
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});
  const inert = await page.evaluate(() => {
    const panes = [...document.querySelectorAll("[role=tabpanel]")];
    const pane = panes.find((p) => getComputedStyle(p).display !== "none") ?? document.body;
    const hints = [...pane.querySelectorAll("[data-plugin-systemprompt-inert]")];
    return {
      count: hints.length,
      text: (hints[0]?.textContent ?? "").trim().slice(0, 70),
      // 反空转：goody-hao（贡献 systemPrompts 的那个插件）必须在场，否则下面的断言没有对象。
      // ⚠ 不要在这里写"看着像锚点"的选择器：e2e-anchor-coverage 守卫会把 e2e 用到的每个
      //   data-* 与源码对账，凭空发明的锚点（首版写了个 data-plugin-id）会当场被抓出来。
      hasGoody: (pane.textContent || "").includes("GoodyHao"),
    };
  });
  console.log(`  · 提示条数=${inert.count} 文案=${JSON.stringify(inert.text)} GoodyHao 在场=${inert.hasGoody}`);
  ok(inert.hasGoody, "反空转：贡献 systemPrompts 的 goody-hao 插件确实在列表里（否则下面的断言无对象）");
  if (K.systemPrompt === false) {
    ok(inert.count >= 1, `当前内核不承接系统 prompt ⇒ 插件页必须有**显式降级提示**（实际 ${inert.count} 条；0 条 = 又变回静默缺面）`);
    ok(inert.text.length > 8, `提示要说清是什么不生效（实际 ${JSON.stringify(inert.text)}）`);
    ok(!/pluginManager\./.test(inert.text), "提示必须是**译文**而不是裸 i18n key");
  } else {
    ok(inert.count === 0, "当前内核承接系统 prompt ⇒ 不该出现降级提示（否则是误报，会让用户以为功能坏了）");
  }

  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条)`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(${K.id} 内核冒烟,零 token)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
