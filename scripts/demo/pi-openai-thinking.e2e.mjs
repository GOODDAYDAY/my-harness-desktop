#!/usr/bin/env node
// pi + openai-completions 路径条目的桌面级终验:隔离 HOME + 真实 pi 内核 + 真实模型,
// 选「DeepSeek V4 Pro OpenAI」(openai-completions 路径)→ 发送 → 思考块必须出正文。
// 对照组:同模型 anthropic 路径(网关把思考块错标成 text,pi-ai 按规范丢弃)无思考。
// 用法: npm run build && node scripts/demo/pi-openai-thinking.e2e.mjs [--port 9342] [--keep]
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9342" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));
// 思考档位拨 high(setupBaseline 默认 off,验思考必须拨高)
const generalFile = join(home, ".my-harness-desktop-dev", "config", "general.json");
writeFileSync(generalFile, JSON.stringify({ ...JSON.parse(readFileSync(generalFile, "utf-8")), defaultThinkingLevel: "high" }, null, 2));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18451" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

const setComposer = (t) => page.evaluate((x) => {
  const ta = document.querySelector("[data-timeline-composer]");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, x); ta.dispatchEvent(new Event("input", { bubbles: true })); ta.focus();
}, t);
const clickSend = () => page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "").includes("发送") && x.getBoundingClientRect().width > 0);
  b?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  b?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});

async function pickModel(name) {
  await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const scope = ta?.closest("div")?.parentElement?.parentElement ?? document.body;
    const trigger = [...scope.querySelectorAll("button")].find((b) => b.querySelector("svg") && (b.textContent || "").trim().length > 2);
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector("[role='menu']", { timeout: 8000 });
  await page.evaluate((n) => {
    const item = [...document.querySelectorAll("[role^='menuitem']")].find((el) => (el.textContent || "").includes(n));
    item?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, name);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 6000 }).catch(() => {});
}

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  await pickModel("DeepSeek V4 Pro OpenAI");
  await setComposer("1+1=? 想一想再回答");
  await clickSend();
  // 收敛
  await page.waitForSelector("[data-composer-stop]", { timeout: 25000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("[data-composer-stop]"), { timeout: 150000, polling: 500 });
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 8000 }).catch(() => {});

  // 等思考块落定(按钮或降级提示)
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => /思考已完成|思考过程/.test(b.textContent || "")) || document.body.innerText.includes("无思考内容"),
    { timeout: 10000, polling: 300 },
  ).catch(() => {});
  const st = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].filter((b) => /思考已完成|思考过程/.test(b.textContent || ""));
    return { thinkingButtons: btns.length, emptyHint: document.body.innerText.includes("无思考内容") };
  });
  console.log(`  · 思考块按钮数 → ${st.thinkingButtons},空提示 → ${st.emptyHint}`);
  ok(st.thinkingButtons > 0, "pi + openai 路径条目:思考块渲染(非空提示)");
  // 展开看正文
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].filter((b) => /思考已完成|思考过程/.test(b.textContent || ""));
    btns[btns.length - 1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 400));
  const expanded = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].filter((b) => /思考已完成|思考过程/.test(b.textContent || ""));
    const box = btns[btns.length - 1]?.parentElement?.querySelector("div.whitespace-pre-wrap");
    return (box?.textContent ?? "").trim().length;
  });
  console.log(`  · 展开正文长度 → ${expanded}`);
  ok(expanded > 0, "pi + openai 路径条目:思考块展开有正文(reasoning_content 正常捕获)");
  ok(consoleTail.length === 0, "页面零报错");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(pi+openai 路径思考可用——对照 anthropic 路径的网关错标)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
