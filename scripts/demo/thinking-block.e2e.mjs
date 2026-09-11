#!/usr/bin/env node
// 思考块展开 e2e —— 隔离 HOME + 种中立层会话(零模型调用,确定性),验证两件事:
//   ① 空思考块(供应商回空 thinking 帧,thinking:"")不再渲染「可点展开器」——
//     显式降级为静态提示「无思考内容」(根因:空正文展开成零高度空白,用户观感
//     =「思考已完成点击没用、不展开、点开也看不到」);
//   ② 有正文的思考块点击展开全文(多行逐字都在,不截断),再点收起。
//
// 用法: npm run build && node scripts/demo/thinking-block.e2e.mjs [--port 9337] [--keep]
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPortFree, launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { clickByText } from "./lib/interact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({
  options: { port: { type: "string", default: "9337" }, keep: { type: "boolean", default: false } },
});
const PORT = Number(args.port);
const APP_PORT = 18427; // 与兄弟 e2e 端口错开

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物,先跑: npm run build");
  process.exit(1);
}

await assertPortFree(PORT);
const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const realHome = homedir();
setupBaseline({ home, realHome, locale: "zh-CN" });
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
const prefs = JSON.parse(readFileSync(prefsFile, "utf-8"));
prefs.lastCwd = projectDir;
writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));

// ── 种中立层会话(header/entries 拆分格式):一条 user + 两条 assistant ──
//   assistant#1:有正文思考块(三行,逐字验证不截断)+ 文本
//   assistant#2:空思考块(thinking:"",供应商空帧的真实落盘形状)+ 文本
const NS = "ns-seeded-thinking";
const now = Date.now();
const THINK_FULL = "第一段思考:先读懂用户要什么。\n第二段思考:逐字验证不截断——这一段必须在展开后完整可见。\n第三段思考收尾,给出结论。";
const sessionsDir = join(home, ".my-harness-desktop-dev", "sessions");
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(join(sessionsDir, `${NS}.header.json`), JSON.stringify({
  neutralSessionId: NS,
  rootLineageId: NS,
  header: {
    kernel: "pi", cwd: projectDir, createdAt: new Date(now - 60000).toISOString(),
    name: "思考块种子会话", lastMessage: "空思考的回复。",
    lastEntryId: `${NS}:3`, updatedAt: new Date(now - 1000).toISOString(),
  },
}));
writeFileSync(join(sessionsDir, `${NS}.entries.json`), JSON.stringify({
  neutralSessionId: NS,
  lineages: [{
    lineageId: NS,
    fork: null,
    entries: [
      { neutralEntryId: `${NS}:0`, message: { role: "user", content: "看看思考块", timestamp: now - 50000 } },
      {
        neutralEntryId: `${NS}:1`,
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: THINK_FULL }, { type: "text", text: "有思考的回复。" }],
          startedAt: now - 49000, timestamp: now - 46800,
        },
      },
      { neutralEntryId: `${NS}:2`, message: { role: "user", content: "再来一条空思考的", timestamp: now - 40000 } },
      {
        neutralEntryId: `${NS}:3`,
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "", thinkingSignature: "" }, { type: "text", text: "空思考的回复。" }],
          startedAt: now - 39000, timestamp: now - 37000,
        },
      },
    ],
  }],
}));

// 第二个会话：只为"切走再切回"用（#18 的判据在重挂，不在首次渲染）。
const NS2 = "ns-seeded-plain";
writeFileSync(join(sessionsDir, `${NS2}.header.json`), JSON.stringify({
  neutralSessionId: NS2,
  rootLineageId: NS2,
  header: {
    kernel: "pi", cwd: projectDir, createdAt: new Date(now - 60000).toISOString(),
    name: "旁边的会话", lastMessage: "旁白。",
    lastEntryId: `${NS2}:1`, updatedAt: new Date(now - 2000).toISOString(),
  },
}));
writeFileSync(join(sessionsDir, `${NS2}.entries.json`), JSON.stringify({
  neutralSessionId: NS2,
  lineages: [{
    lineageId: NS2,
    fork: null,
    entries: [
      { neutralEntryId: `${NS2}:0`, message: { role: "user", content: "旁白", timestamp: now - 30000 } },
      { neutralEntryId: `${NS2}:1`, message: { role: "assistant", content: [{ type: "text", text: "旁白。" }], timestamp: now - 29000 } },
    ],
  }],
}));

const app = await launchApp({ appDir: ROOT, port: PORT, env: { HOME: home, MHD_PORT: String(APP_PORT) }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("console", (m) => { if (m.type() === "error") consoleTail.push(m.text()); });
page.on("pageerror", (e) => consoleTail.push(`[pageerror] ${e.message}`));

try {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 从会话列表点开种子会话(事件驱动等列表项,最多重试 3 次——与 message-actions 同款)
  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    await page.waitForFunction(
      () => [...document.querySelectorAll("*")].some((e) => (e.textContent || "").trim() === "思考块种子会话" && e.children.length < 6),
      { timeout: 15000, polling: 300 },
    );
  // 会话行点击走可信点击(合成 MouseEvent 对 Radix 行点击实测翻车过)。
  if (!(await clickByText(page, '思考块种子会话', { exact: true }))) throw new Error("未找到会话行: 思考块种子会话");
    opened = await page.waitForFunction(() => document.body.innerText.includes("空思考的回复。"), { timeout: 8000, polling: 300 })
      .then(() => true)
      .catch(() => false);
  }
  ok(opened, "会话列表点开种子会话 + 两条 assistant 消息渲染");
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 }).catch(() => {});

  // ⓪ 消息元信息徽标(MessageMeta)在种子消息上渲染(确定性:种子条目带数值 timestamp,
  //   buildMessageMeta 必出 clock)——顺带验 DOM 组装,回归 aria-label="message-meta" 锚点。
  const metaCount = await page.evaluate(() => document.querySelectorAll("[aria-label='message-meta']").length);
  ok(metaCount >= 2, `消息元信息徽标渲染(${metaCount} 个,aria-label=message-meta)`);

  // ① 空思考块:显式降级——「无思考内容」提示在,且它不在任何 button 里(无展开器)
  const emptyState = await page.evaluate(() => {
    const body = document.body.innerText;
    const hasHint = body.includes("无思考内容");
    const hintInButton = [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("无思考内容"));
    return { hasHint, hintInButton };
  });
  ok(emptyState.hasHint, "空思考块显示「无思考内容」提示(显式降级,不静默)");
  ok(!emptyState.hintInButton, "「无思考内容」不在 button 里(不再是点击无反应的死控件)");

  // ② 有正文思考块:默认折叠(正文不在)→ 点击「思考已完成」展开 → 三行逐字都在 → 再点收起
  const beforeClick = await page.evaluate(() => document.body.innerText.includes("第二段思考"));
  ok(!beforeClick, "展开前正文不可见(默认折叠)");
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /思考已完成|思考过程/.test(b.textContent || ""));
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  ok(clicked, "找到「思考已完成」展开按钮并点击");
  await page.waitForFunction(
    () => {
      const t = document.body.innerText;
      return t.includes("第一段思考") && t.includes("第二段思考:逐字验证不截断——这一段必须在展开后完整可见。") && t.includes("第三段思考收尾");
    },
    { timeout: 5000, polling: 200 },
  );
  ok(true, "点击后思考全文展开(三段逐字都在,无任何截断)");
  await page.screenshot({ path: join(runRoot, "thinking-expanded.png") });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /思考已完成|思考过程/.test(b.textContent || ""));
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForFunction(() => !document.body.innerText.includes("第二段思考"), { timeout: 5000, polling: 200 });
  ok(true, "再点收起(展开/收起双向可用)");

  // ③ **#18 的真判据：重挂之后仍然保持展开**（用户原话「打开的话就一直打开，
  //    别我看着看着，又自动收起来了」）。
  //
  //    为什么这一条必须在**真实 app** 里做、且必须靠"切走再切回"：
  //    缺陷形态是 Virtuoso 因 computeItemKey 变化**换掉组件实例**（消息 id 从流式 id 变成
  //    neutralEntryId），局部 state 归零 → 用户展开的那块又合上。jsdom 里能用
  //    unmount+全新 render 复现（`thinking-chain-block.test.tsx` 已有那条），但
  //    **只有真 app 的虚拟列表才会真的重挂**——切走再切回正是触发它的最短真实路径。
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /思考已完成|思考过程/.test(b.textContent || ""));
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForFunction(() => document.body.innerText.includes("第二段思考"), { timeout: 5000, polling: 200 });
  ok(true, "重挂守卫前置：先把思考块展开");

  /** 消息区里有没有这段文本（不用 body.innerText：侧栏预览会干扰，见上）。 */
  const messagesContain = (page_, needle) =>
    page_.evaluate((n) => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(n)), needle);

  if (!(await clickByText(page, "旁边的会话", { exact: true }))) throw new Error("未找到会话行: 旁边的会话");
  // ⚠ 判据只看**消息区**，不用 body.innerText：侧栏会话行的 `lastMessage` 预览会把
  //   "空思考的回复。"一直留在 body 里（skills §3.5），拿 body 判"切走了没"永远为假——
  //   本轮实测被它卡住一次。
  await page.waitForFunction(
    () => {
      const texts = [...document.querySelectorAll("[data-message-id]")].map((el) => el.textContent || "");
      return texts.some((t) => t.includes("旁白。")) && !texts.some((t) => t.includes("空思考的回复。"));
    },
    { timeout: 8000, polling: 300 },
  );
  ok(true, "已切到旁边的会话(消息区只剩旁白)");

  if (!(await clickByText(page, "思考块种子会话", { exact: true }))) throw new Error("未找到会话行: 思考块种子会话");
  await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("空思考的回复。")),
    { timeout: 8000, polling: 300 },
  );
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 8000 }).catch(() => {});
  ok(!(await messagesContain(page, "旁白。")), "切回来了(消息区不含另一个会话的内容)");

  const stillOpen = await page.evaluate(() => {
    const t = document.body.innerText;
    return { second: t.includes("第二段思考:逐字验证不截断——这一段必须在展开后完整可见。"), third: t.includes("第三段思考收尾") };
  });
  ok(
    stillOpen.second && stillOpen.third,
    `切走再切回后思考块**仍保持展开**(实际 second=${stillOpen.second} third=${stillOpen.third};` +
      `收起即 #18 复发——用户展开的东西被重挂抹掉了)`,
  );

  // ④ **运行态动效真的进了产物**（构建产物级守卫，零 token）。
  //
  //   为什么要在 e2e 里查产物 CSS：既有守卫只到"源码里写了类名/关键帧"这一层，
  //   而用户看到的"图标不动"还有第二条成因链 —— Tailwind 的 `@source` 扫描没覆盖到某个目录，
  //   于是 `.animate-pulse` 这类**工具类根本没被生成**（本仓记录过两次：`@source ../../plugins`
  //   指向不存在的旧目录，导致插件内整批工具类漏生成）。那时类名还在、DOM 断言还绿，
  //   但样式表里没有规则 —— 元素就是不动。
  //   产物 CSS 是"用户真正加载到的东西"，只有它能同时覆盖两条成因链。
  const cssFiles = readdirSync(join(ROOT, "out", "renderer", "assets")).filter((f) => f.endsWith(".css"));
  const css = cssFiles.map((f) => readFileSync(join(ROOT, "out", "renderer", "assets", f), "utf-8")).join("\n");
  ok(cssFiles.length > 0, `产物 CSS 存在（${cssFiles.length} 个）`);
  ok(/\.animate-pulse\s*\{[^}]*animation/.test(css), "`.animate-pulse` 规则进了产物（@source 没漏扫 → 工具类真被生成）");
  ok(/@keyframes\s+tool-live-pulse/.test(css), "`@keyframes tool-live-pulse`（工具执行中呼吸条）进了产物");
  ok(/@keyframes\s+stream-caret-breathe/.test(css), "`@keyframes stream-caret-breathe`（打印中光标）进了产物");

  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条${consoleTail[0] ? `: ${consoleTail[0].slice(0, 120)}` : ""})`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言全部通过(思考块:空内容显式降级 + 展开全文 + 重挂后仍保持展开 + 产物动效落地)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await page.screenshot({ path: join(runRoot, "thinking-fail.png") }).catch(() => {});
  console.error(`现场保留: ${runRoot}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
