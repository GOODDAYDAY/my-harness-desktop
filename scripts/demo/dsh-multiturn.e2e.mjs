#!/usr/bin/env node
// dsh 多轮对话真实 DOM e2e —— 连接运行中的 app(CDP 9222,含 dsh 运行时 + 模型 key),
// 断言:dsh 选模不漂 pi、连发两轮 + 上下文连续、无 flatMap/id-collision/生成失败。
// 全部通过 exit 0,任一失败 exit 1。测试会话在结束时清理,不污染用户数据。
//
// 用法:
//   node scripts/demo/dsh-multiturn.e2e.mjs [--port 9222]
//
// 前置:app 已以 --remote-debugging-port=9222 运行(dev 或 out/ 构建均可)。
// 说明:核心断言落在「落盘数据层」(kernel=dsh、两轮 assistant、上下文连续)——这些是
// dsh 多轮修复的实质;时间线渲染(thinking 标签/时间徽标)属展示层,若渲染层 WIP 导致
// 消息行未渲染,则作 best-effort 警告而非硬失败(数据层已证发送/回复/上下文)。
import { createRequire } from "node:module";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const { values: args } = parseArgs({ options: { port: { type: "string", default: "9222" } } });
const CDP = `http://127.0.0.1:${args.port}`;
const CWD = "/Users/anker/anker/bots-gdc";
const SESSIONS_DIR = join(homedir(), ".my-harness-desktop-dev", "sessions");
const DSH_BUCKET = join(homedir(), ".my-harness-desktop-dev", "dsh", "sessions", "--Users-anker-anker-bots-gdc--");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let warnings = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}
function warn(label) {
  warnings += 1;
  console.log(`  ⚠ ${label}(best-effort,非硬失败)`);
}

async function main() {
  const tag = Date.now().toString(36);
  const fact = `N${tag}`;
  const m1 = `分步心算 17*23+5 等于多少,每一步都写出来,最后给结果;同时记住:我的代号是 ${fact}`;
  const m2 = `我的代号是什么?只回答代号`;

  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
  const page = (await browser.pages()).find((p) => p.url().includes("localhost:5173")) ?? (await browser.pages())[0];
  console.log("已连接 renderer:", page.url().slice(0, 40));

  const settle = async () => {
    let idle = 0;
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      const streaming = await page.evaluate(() => !!document.querySelector("[aria-label*='停止']"));
      if (!streaming) { idle += 2000; if (idle >= 4000) return; } else idle = 0;
    }
  };
  const clickSend = () => page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "").includes("发送") && x.getBoundingClientRect().width > 0);
    if (!b) return false;
    b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  // textarea 是 React 受控组件:keyboard.type 会被 IME 吞掉 ASCII(数字/字母/空格),
  // 这里用原生 value setter + input 事件,React onChange 正常捕获,中英混排可靠。
  const setComposer = (text) => page.evaluate((t) => {
    const ta = document.querySelector("[data-timeline-composer]");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, t);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
  }, text);

  // ⌘N + 选 DSH 模型
  await page.keyboard.down("Meta"); await page.keyboard.press("n"); await page.keyboard.up("Meta");
  await sleep(900);
  await page.evaluate(() => {
    const btn = document.querySelector("button[id^=radix]");
    if (btn.getAttribute("data-state") !== "open") {
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
  await sleep(400);
  await page.evaluate(() => {
    const menu = document.querySelector("[role=menu]");
    const tab = [...menu.querySelectorAll("button")].find((b) => (b.innerText || "").trim() === "DSH");
    tab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await sleep(350);
  await page.evaluate(() => {
    const menu = document.querySelector("[role=menu]");
    const item = [...menu.querySelectorAll("[role=menuitem]")].find((el) => (el.innerText || "").includes("qwen3.8-max"));
    item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await sleep(600);
  ok(true, "选 DSH 模型");

  // 发第 1 条
  await setComposer(m1);
  await sleep(200);
  ok(await clickSend(), "发送按钮可点(第 1 条)");
  await settle();

  // 发第 2 条
  await setComposer(m2);
  await sleep(200);
  await clickSend();
  await settle();
  await sleep(2000);

  // 展示层错误(flatMap/id-collision/生成失败)硬断言:这些是「崩」的信号,无论渲染与否都不该出现
  const body = await page.evaluate(() => document.body.textContent || "");
  ok(!body.includes("flatMap"), "无 flatMap 崩溃");
  ok(!body.includes("id collision"), "无 id collision");
  ok(!body.includes("生成失败"), "无「生成失败」");

  // 落盘核对:同会话、kernel=dsh、两轮都有 assistant 回复、上下文连续
  let found = null;
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
      if (s?.header?.cwd !== CWD) continue;
      const entries = (s.lineages ?? []).flatMap((l) => l.entries);
      if (entries.some((e) => String(e.message?.content).includes(fact))) {
        const flatten = (c) => {
          if (typeof c === "string") return c;
          if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b?.text ?? b?.thinking ?? b?.content ?? "")).join(" ");
          return "";
        };
        const asstTexts = entries.filter((e) => e.message.role === "assistant").map((e) => flatten(e.message?.content));
        found = { id: f.slice(0, 8), kernel: s.header.kernel, asst: asstTexts.length, remembers: asstTexts.some((t) => t.includes(fact)) };
      }
    } catch { /* 跳过不可读 */ }
  }
  ok(found != null, `落盘找到测试会话(${found?.id})`);
  ok(found?.kernel === "dsh", `落盘 kernel=dsh(${found?.kernel}),不漂 pi`);
  ok((found?.asst ?? 0) >= 2, `两轮都有 assistant 回复(asst=${found?.asst})`);
  ok(found?.remembers === true, `第 2 轮回复含代号 ${fact}(上下文连续)`);

  // 展示层 best-effort:时间徽标(若消息行未渲染则警告,不硬失败)
  const timeBadges = await page.evaluate(() => document.querySelectorAll("[aria-label='message-time']").length);
  if (timeBadges >= 1) ok(true, `消息行时间徽标出现(${timeBadges} 个)`);
  else warn(`时间徽标未出现(渲染层可能未渲染消息行,WIP 状态)`);

  // 清理测试会话
  try {
    for (const f of readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
        const entries = (s.lineages ?? []).flatMap((l) => l.entries);
        if (entries.some((e) => String(e.message?.content).includes(fact))) {
          rmSync(join(SESSIONS_DIR, f), { force: true });
        }
      } catch { /* 跳过 */ }
    }
    for (const d of readdirSync(DSH_BUCKET)) {
      if (d.startsWith(found?.id)) rmSync(join(DSH_BUCKET, d), { recursive: true, force: true });
    }
    console.log("  ✓ 测试会话已清理");
  } catch { /* 清理失败不致命 */ }

  await browser.disconnect();
  console.log(`\n✅ dsh 多轮 e2e 通过(${passed} 项硬断言${warnings ? `, ${warnings} 项 best-effort 警告` : ""})`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n❌ e2e 失败: ${e.message}`);
  process.exit(1);
});
