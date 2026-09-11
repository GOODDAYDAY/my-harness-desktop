#!/usr/bin/env node
// 思考块展开 e2e —— 隔离 HOME + 种中立层会话(零模型调用,确定性),验证两件事:
//   ① 空思考块(供应商回空 thinking 帧,thinking:"")不再渲染「可点展开器」——
//     显式降级为静态提示「无思考内容」(根因:空正文展开成零高度空白,用户观感
//     =「思考已完成点击没用、不展开、点开也看不到」);
//   ② 有正文的思考块点击展开全文(多行逐字都在,不截断),再点收起。
//
// 用法: npm run build && node scripts/demo/thinking-block.e2e.mjs [--port 9337] [--keep]
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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

  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条${consoleTail[0] ? `: ${consoleTail[0].slice(0, 120)}` : ""})`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言全部通过(思考块:空内容显式降级 + 有内容点击展开全文)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await page.screenshot({ path: join(runRoot, "thinking-fail.png") }).catch(() => {});
  console.error(`现场保留: ${runRoot}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
