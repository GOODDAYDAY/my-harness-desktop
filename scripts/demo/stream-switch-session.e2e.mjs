#!/usr/bin/env node
// 交叠态守卫:流式中切走会话(回合未收敛就切)→ 新会话壳必须干净、切回必须不残留。
//
// 为什么单独建这条:skills 索引里记着「流式中切换(r321/r322)」与「中断×续跑(r354)」,
// 但全仓 35 个 e2e 没有任何一条真的跑这个交叠态(那些是人工探索轮,没落成常驻守卫)。
// 历史 bug 聚集地正是这里:重开竞态、切项目残留、思考中永挂——都是"回合没结束就动了别的"。
//
// 用 dsh 真实模型(回合够长,能稳定抓到流式中)。断言只写**该状态真正保证的事**(skills §10.3):
//  ① 流式中确实处于流式态(停止钮在)——前提没成立就跳过,别假绿;
//  ② 切走后新会话壳干净:无「思考中」残留、无上一条会话的消息;
//  ③ 切回后:上一条会话的 user 消息仍在(内容没丢),且无「思考中」永挂。
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9375" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label) {
  const mark = cond ? "✓" : "✗";
  console.log(`  ${mark} ${label}`);
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
}

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18490" }, timeoutMs: 90000 });
const page = app.page;
const errs = []; page.on("pageerror", (e) => errs.push(e.message));

const streaming = () => page.evaluate(() => !!document.querySelector("[aria-label*='停止']"));
const thinkingStuck = () => page.evaluate(() => document.body.innerText.includes("思考中"));
const msgTexts = () => page.evaluate(() => [...document.querySelectorAll("[data-message-id]")].map((e) => (e.textContent || "").trim().slice(0, 40)));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 选 dsh 真实模型
  await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const scope = ta?.closest("div")?.parentElement?.parentElement ?? document.body;
    const trigger = [...scope.querySelectorAll("button")].find((b) => b.querySelector("svg") && (b.textContent || "").trim().length > 2);
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector("[role='menu']", { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => {
    const tab = [...(document.querySelector("[role='menu']")?.querySelectorAll("button") ?? [])]
      .find((b) => (b.textContent || "").trim().toLowerCase() === "dsh");
    tab?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    tab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 6000 }).catch(() => {});
  const picked = await page.evaluate(() => {
    const item = [...document.querySelectorAll("[role='menuitem']")].find((el) => el.getBoundingClientRect().width > 0);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, t: (item.textContent || "").trim().slice(0, 24) };
  });
  ok(!!picked, `已选 dsh 模型(${picked?.t ?? "无"})`);
  if (picked) await page.mouse.click(picked.x, picked.y);
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 6000 }).catch(() => {});

  // 发一条"长回复"指令——回合够长才能稳定抓到流式中
  await page.click("[data-timeline-composer]");
  await page.keyboard.type("请写一段大约 400 字的说明文字,分多段,不要列表。");
  await page.keyboard.press("Enter");

  // ① 前提:必须真的进到流式态(等不到就跳过,不假绿/不假红)
  const live = await page.waitForSelector("[aria-label*='停止']", { timeout: 30000 }).then(() => true).catch(() => false);
  if (!live) {
    console.log("  ⚠ 30s 内未进入流式态(模型慢/网络),本条 e2e 的前提不成立 → 跳过,不计通过");
    await killApp(app);
    if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log("\n⚠ SKIP: 交叠态守卫(前提未成立)");
    process.exit(0);
  }
  ok(true, "① 流式中确实处于流式态(停止钮在)");

  // ② 流式中切走:⌘N 新会话
  const beforeSwitch = await msgTexts();
  await page.keyboard.down("Meta"); await page.keyboard.press("n"); await page.keyboard.up("Meta");
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 8000 }).catch(() => {});
  const afterRows = await msgTexts();
  ok(afterRows.length === 0, `② 切走后新会话壳无历史消息(实际 ${afterRows.length} 条)`);
  const stuckAfterSwitch = await thinkingStuck();
  ok(!stuckAfterSwitch, "② 切走后新会话壳无「思考中」残留");
  ok(beforeSwitch.length > 0, `② 切走前原会话确有内容(${beforeSwitch.length} 条,证明不是空转到这一步)`);

  // ③ 切回原会话:内容在、无「思考中」永挂
  // 必须点**真会话行**,不能点乐观「新对话」行(path 以 `new:` 前缀)——⌘N 之后它就排在第一个,
  // 按"第一行有文字"取会点中它(点了等于还在新会话壳里),这是探针歧义,不是 app 问题。
  const rowRect = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-session-path]")]
      .filter((r) => !(r.getAttribute("data-session-path") || "").startsWith("new:"));
    const row = rows[0];
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, t: (row.textContent || "").trim().slice(0, 20) };
  });
  ok(!!rowRect, `③ 左栏有可点的真会话行(${rowRect?.t ?? "无"})`);
  if (rowRect) await page.mouse.click(rowRect.x, rowRect.y);
  const restored = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("请写一段大约 400 字")),
    { timeout: 15000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(restored, "③ 切回后原会话的 user 消息仍在(内容没丢)");
  const stuckAfterBack = await thinkingStuck();
  ok(!stuckAfterBack, "③ 切回后无「思考中」永挂(abort/缺 assistant 的历史根因)");

  ok(errs.length === 0, `页面零报错(实际 ${errs.length} 条:${errs.slice(0, 2).join(" | ")})`);
  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(流式中切会话交叠态)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(1);
}
