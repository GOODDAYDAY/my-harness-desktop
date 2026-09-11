#!/usr/bin/env node
// 三优先问题实锤 e2e(2026-09-07 用户报告)——拉起 out/ 构建产物(隔离 HOME + CDP),
// 真实 pi + dsh 双内核 + 真实模型(花真 token,三条 tiny prompt),长交互四幕:
//   幕A pi 思考展示(能思考的模型):apps-studio/Glm 5.2 —— 网关实发 thinking_delta,
//     会话流应出现思考块且展开有正文(「pi 不能触发思考/无法展示」的对照组)。
//   幕B pi 思考展示(空帧模型):apps-studio/Qwen3.8 Max —— 网关只回空 thinking 帧,
//     应显示「无思考内容」静态提示而不是死展开器(59f18c6d 修复的线上验证)。
//   幕C pi 会话在时新会话切 dsh 模型:pi 会话有历史 → 开新会话 → 选 dsh 模型 →
//     发送 → 应走 dsh 内核出回复(「pi 时开新会话不能切 dsh 模型」的复现面)。
//   幕D dsh 会话的思考深度入口实况:composer 思考档位控件在 dsh 下的呈现
//     (现状=levels 空 → 下拉不画;采集 DOM 证据,给「DSH 无法切思考深度」定面)。
//
// 用法: npm run build && node scripts/demo/kernel-thinking-matrix.e2e.mjs [--port 9338] [--keep]
// 注意: 花真实 token(三条 prompt);pi/dsh 内核与凭证从真实 HOME 链接+拷贝进隔离区。
import { parseArgs } from "node:util";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPortFree, launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({
  options: { port: { type: "string", default: "9338" }, keep: { type: "boolean", default: false } },
});
const PORT = Number(args.port);
const APP_PORT = 18428;

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}
/** 软观察(不炸,只记录):用于「采集现状证据」类检查点。 */
const notes = [];
function note(label, value) {
  notes.push(`${label}: ${value}`);
  console.log(`  · ${label} → ${value}`);
}

if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物,先跑: npm run build");
  process.exit(1);
}

// ---------- 隔离 HOME:pi 内核/模型 + dsh 内核/配置/凭证 ----------
await assertPortFree(PORT);
const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
const shotsDir = join(runRoot, "shots");
mkdirSync(shotsDir, { recursive: true });
const realHome = homedir();
setupBaseline({ home, realHome, locale: "zh-CN" });
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
const prefs = JSON.parse(readFileSync(prefsFile, "utf-8"));
prefs.lastCwd = projectDir;
writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));
// 思考档位基线拨到 high:setupBaseline 默认种 "off"(演示省 token),而本脚本验的正是
// 「思考触发+展示」——off 会让 pi 不发思考,幕A 必假阴性(实测踩过:level=off 落盘)。
const generalFile = join(home, ".my-harness-desktop-dev", "config", "general.json");
const general = JSON.parse(readFileSync(generalFile, "utf-8"));
general.defaultThinkingLevel = "high";
writeFileSync(generalFile, JSON.stringify(general, null, 2));
// dsh 三件套(内核目录符号链接;配置/凭证拷贝防写回;node_modules 符号链接供适配插件解析)
const realDsh = join(realHome, ".my-harness-desktop-dev", "dsh");
if (existsSync(realDsh)) symlinkSync(realDsh, join(home, ".my-harness-desktop-dev", "dsh"), platform() === "win32" ? "junction" : undefined);
mkdirSync(join(home, ".dsh"), { recursive: true });
for (const f of ["cordis.yml", "settings.yaml", ".credentials.yaml"]) {
  const src = join(realHome, ".dsh", f);
  if (existsSync(src)) copyFileSync(src, join(home, ".dsh", f));
}
const realDshNm = join(realHome, ".dsh", "node_modules");
if (existsSync(realDshNm)) symlinkSync(realDshNm, join(home, ".dsh", "node_modules"), platform() === "win32" ? "junction" : undefined);
// 幕D 前置:给隔离区 dsh settings.yaml 的 us-new 全模型补 reasoningEfforts(推理元数据
// 是档位清单/校验的前提——dsh-thinking-level.md §5;真实用户的模型经模型页 reasoning 开关写入)。
{
  const { parse, stringify } = await import("yaml");
  const settingsFile = join(home, ".dsh", "settings.yaml");
  const doc = parse(readFileSync(settingsFile, "utf-8")) ?? {};
  const providers = doc["llm-pi-ai"]?.providers ?? {};
  for (const route of Object.values(providers)) {
    for (const m of route?.models ?? []) m.reasoningEfforts = { off: null, low: "low", medium: "medium", high: "high" };
  }
  writeFileSync(settingsFile, stringify(doc), "utf-8");
}

const app = await launchApp({ appDir: ROOT, port: PORT, env: { HOME: home, MHD_PORT: String(APP_PORT), MHD_CAPS_DEBUG: join(runRoot, "caps-debug.log") }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("console", (m) => { if (m.type() === "error") consoleTail.push(m.text()); });
page.on("pageerror", (e) => consoleTail.push(`[pageerror] ${e.message}`));

// ---------- DOM 交互助手(按角色/文案查,不按 class 查) ----------
const setComposer = (text) => page.evaluate((t) => {
  const ta = document.querySelector("[data-timeline-composer]");
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, t);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  return true;
}, text);

const clickSend = () => page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || x.title || "").includes("发送") && x.getBoundingClientRect().width > 0);
  if (!b) return false;
  b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return true;
});

/** 等回合收敛:停止钮出现(真起跑)→ 消失(收敛)。端点挂起时两阶段超时会给出明确现场。 */
async function settle(timeoutMs = 150000) {
  const appeared = await page.waitForSelector("[aria-label*='停止']", { timeout: 25000 }).then(() => true).catch(() => false);
  if (!appeared) console.warn("   [settle] 25s 内停止钮未出现,回合可能未起跑");
  await page.waitForFunction(() => !document.querySelector("[aria-label*='停止']"), { timeout: timeoutMs, polling: 500 });
}

/** 开新会话:点会话列表所在侧栏的「新会话」按钮。
 *  精确前缀匹配 title("新会话 (⌘N)")——「刷新会话列表」含子串「新会话」,
 *  includes 模糊匹配会先点中刷新钮(实测踩过:新会话从未建成,双幕共用一条会话)。 */
async function startNewChat() {
  const done = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => {
      const s = x.title || x.getAttribute("aria-label") || "";
      return (s.startsWith("新会话") || /^new (chat|session)/i.test(s)) && x.getBoundingClientRect().width > 0;
    });
    if (!b) return false;
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  if (!done) throw new Error("找不到「新会话」按钮");
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 }).catch(() => {});
}

/** 打开 composer 模型下拉 → (可选)点内核 TAB → 按显示名点模型项。
 *  Radix DropdownMenu 需要真实 pointer 序列;模型项 role=menuitem。 */
async function pickModel(modelName, kernelTab) {
  // 1. 开下拉(幂等:已开则跳过——触发器是 toggle,重复点击会把它关掉,实测踩过)
  const alreadyOpen = await page.evaluate(() => !!document.querySelector("[role='menu']"));
  if (!alreadyOpen) {
    await page.evaluate(() => {
      const ta = document.querySelector("[data-timeline-composer]");
      const scope = ta?.closest("div")?.parentElement?.parentElement ?? document.body;
      const btns = [...scope.querySelectorAll("button")].filter((b) => b.querySelector("svg") && (b.textContent || "").trim().length > 0);
      const trigger = btns.find((b) => !/^(off|minimal|low|medium|high|xhigh)$/i.test((b.textContent || "").trim()) && (b.textContent || "").trim().length > 2);
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }
  // Radix 下拉对合成事件的响应有时序窗口(实测:会话切换后的首轮点击偶发不打开)——
  // 没开就 dump 现场 + 真实鼠标坐标点一次兜底,再不行才算失败。
  let menuOpen = await page.waitForSelector("[role='menu']", { timeout: 3000 }).then(() => true).catch(() => false);
  if (!menuOpen) {
    const diag = await page.evaluate(() => {
      const ta = document.querySelector("[data-timeline-composer]");
      return { composerThere: !!ta, bodyHead: document.body.innerText.replace(/\s+/g, " ").slice(0, 200) };
    });
    console.warn(`   [pickModel] 首次点击未开菜单,现场: ${JSON.stringify(diag)}`);
    await page.evaluate(() => {
      const ta = document.querySelector("[data-timeline-composer]");
      const scope = ta?.closest("div")?.parentElement?.parentElement ?? document.body;
      const btns = [...scope.querySelectorAll("button")].filter((b) => b.querySelector("svg") && (b.textContent || "").trim().length > 0);
      const trigger = btns.find((b) => !/^(off|minimal|low|medium|high|xhigh)$/i.test((b.textContent || "").trim()) && (b.textContent || "").trim().length > 2);
      if (trigger) {
        const r = trigger.getBoundingClientRect();
        trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
        trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
        trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
      }
    });
    menuOpen = await page.waitForSelector("[role='menu']", { timeout: 3000 }).then(() => true).catch(() => false);
  }
  if (!menuOpen) throw new Error("模型下拉未打开(两次尝试后)");
  // 2. 内核 TAB(多内核才有点):文本恰为 pi/dsh 的 button
  if (kernelTab) {
    const tabbed = await page.evaluate((k) => {
      const menu = document.querySelector("[role='menu']");
      if (!menu) return false;
      const tab = [...menu.querySelectorAll("button")].find((b) => (b.textContent || "").trim().toLowerCase() === k);
      if (!tab) return false;
      tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    }, kernelTab);
    if (!tabbed) console.warn(`   [pickModel] 内核 TAB「${kernelTab}」未找到(可能已锁定/单内核)`);
    await new Promise((r) => setTimeout(r, 300));
  }
  // 3. 点模型项(role=menuitem,文本含显示名,且必须可见+未禁用——隐藏内核清单是 inert div、
  //  锁内核的项 aria-disabled,点了 Radix 也不触发 onSelect)
  const picked = await page.evaluate((name) => {
    const item = [...document.querySelectorAll("[role='menuitem']")].find((el) =>
      (el.textContent || "").includes(name)
      && el.getBoundingClientRect().width > 0
      && el.getAttribute("aria-disabled") !== "true");
    if (!item) return false;
    item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  }, modelName);
  if (!picked) {
    const inventory = await page.evaluate(() =>
      [...document.querySelectorAll("[role='menuitem']")].map((el) => `${(el.textContent || "").trim().slice(0, 26)}${el.getAttribute("aria-disabled") === "true" ? "(禁)" : ""}`));
    throw new Error(`模型项「${modelName}」未找到/不可点;当前项: ${JSON.stringify(inventory)}`);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 6000 }).catch(() => {});
}

try {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  // 能力面推送插桩(根因定位用):记录每一次 capabilitiesChanged 的 payload 时序
  await page.evaluate(() => {
    (window).__capsLog = [];
    window.kernel.sessions.onKernelEvent((e) => {
      if (e?.kind === "capabilitiesChanged") (window).__capsLog.push({ t: Date.now(), caps: e.capabilities });
    });
  });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  console.log("应用已起,composer 就位\n");

  // ============ 幕A:pi 思考展示(能思考的模型 Glm 5.2)============
  console.log("幕A: pi + Glm 5.2(网关实发 thinking_delta)→ 思考块应展示正文");
  await pickModel("Glm 5.2 (Free)", "pi");
  ok(await setComposer("1+1=? 请先思考再回答"), "幕A 输入框写入");
  ok(await clickSend(), "幕A 发送点击");
  await settle();
  // 思考块落地等 DOM(事件驱动):settle 的停止钮轮询对极速回合会漏看(出现+消失落在 500ms
  //  轮询间隙),内容写穿/镜像合入尚需一拍——等「思考按钮 或 无思考内容提示」任一出现再断言。
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => /思考已完成|思考过程/.test(b.textContent || ""))
      || document.body.innerText.includes("无思考内容"),
    { timeout: 10000, polling: 300 },
  ).catch(() => {});
  // DOM×文件对账(纪律:落盘文件是真相源,DOM 必须与之一致):文件有思考块 → DOM 必须有
  //  思考按钮/降级提示;文件没有 → 模型这轮没思考(网关/模型裁量,合法),记观察不炸。
  const bucketDir = join(home, ".pi", "agent", "sessions");
  let fileHasThinking = false;
  if (existsSync(bucketDir)) {
    for (const bucket of readdirSync(bucketDir)) {
      for (const f of readdirSync(join(bucketDir, bucket)).filter((x) => x.endsWith(".jsonl"))) {
        const lines = readFileSync(join(bucketDir, bucket, f), "utf-8").split("\n");
        if (lines.some((l) => l.includes('"type":"thinking"'))) fileHasThinking = true;
      }
    }
  }
  note("幕A 会话文件含思考块", fileHasThinking);
  const a1 = await page.evaluate(() => {
    const labels = [...document.querySelectorAll("button")].filter((b) => /思考已完成|思考过程/.test(b.textContent || ""));
    const emptyHints = document.body.innerText.includes("无思考内容");
    return { thinkingButtons: labels.length, emptyHints };
  });
  note("幕A 思考块按钮数", a1.thinkingButtons);
  note("幕A 出现「无思考内容」", a1.emptyHints);
  if (fileHasThinking) {
    ok(a1.thinkingButtons > 0 || a1.emptyHints, "幕A 文件有思考块 → DOM 必须呈现(展开钮或空内容降级提示)");
  } else {
    note("幕A 模型本轮未产出思考块(网关/模型裁量),跳过 DOM 断言", "skip");
  }
  // 展开最新思考块,断言正文非空(仅文件确有思考块时——模型裁量不思考的轮次没有可展开对象)
  if (fileHasThinking) await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].filter((b) => /思考已完成|思考过程/.test(b.textContent || ""));
    btns[btns.length - 1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 400));
  const a2 = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].filter((b) => /思考已完成|思考过程/.test(b.textContent || ""));
    const btn = btns[btns.length - 1];
    const box = btn?.parentElement;
    const body = box?.querySelector("div.whitespace-pre-wrap");
    return { expandedText: (body?.textContent ?? "").trim() };
  });
  note("幕A 展开的思考正文长度", a2.expandedText.length);
  if (fileHasThinking && a1.thinkingButtons > 0) {
    ok(a2.expandedText.length > 0, "幕A 思考块展开后正文非空(pi 思考展示链路活着)");
  }
  await page.screenshot({ path: join(shotsDir, "A-pi-thinking.png") });

  // ============ 幕B:pi 空帧模型(Qwen3.8 Max)→「无思考内容」提示 ============
  console.log("\n幕B: pi + Qwen3.8 Max(网关回空 thinking 帧)→ 静态提示,无死展开器");
  await startNewChat();
  await pickModel("Qwen3.8 Max (Free)", "pi");
  ok(await setComposer("1+1=?"), "幕B 输入框写入");
  ok(await clickSend(), "幕B 发送点击");
  await settle();
  // 同幕A:等思考区落定(空帧模型应落「无思考内容」提示)再断言,不赌固定静默窗口
  await page.waitForFunction(
    () => document.body.innerText.includes("无思考内容")
      || [...document.querySelectorAll("button")].some((b) => /思考已完成|思考过程/.test(b.textContent || "")),
    { timeout: 10000, polling: 300 },
  );
  const b1 = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const hintInButton = [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("无思考内容"));
    return { hasEmptyHint: bodyText.includes("无思考内容"), hintInButton, thinkingBtns: [...document.querySelectorAll("button")].filter((b) => /思考已完成|思考过程/.test(b.textContent || "")).length };
  });
  note("幕B 「无思考内容」出现", b1.hasEmptyHint);
  note("幕B 提示在 button 里(死控件)", b1.hintInButton);
  note("幕B 残留思考展开钮", b1.thinkingBtns);
  ok(b1.hasEmptyHint && !b1.hintInButton, "幕B 空思考显式降级为静态提示(59f18c6d 线上生效)");
  await page.screenshot({ path: join(shotsDir, "B-pi-empty-thinking.png") });

  // ============ 幕C:pi 会话有历史 → 新会话 → 选 dsh 模型 → 发送 ============
  console.log("\n幕C: pi 会话在时,新会话切 dsh 模型发送");
  await startNewChat();
  // 采集:主侧能力面真相(IPC 直读)+ 渲染层模型下拉的 TAB 锁定态(两端对账)
  note("幕C 主侧 getCapabilities", JSON.stringify(await page.evaluate(() => window.kernel.sessions.getCapabilities())));
  note("幕C capabilitiesChanged 推送流水", JSON.stringify(await page.evaluate(() => (window).__capsLog?.map((x) => x.caps) ?? "无")));
  await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const scope = ta?.closest("div")?.parentElement?.parentElement ?? document.body;
    const trigger = [...scope.querySelectorAll("button")].find((b) => b.querySelector("svg") && (b.textContent || "").trim().length > 2);
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector("[role='menu']", { timeout: 5000 });
  const c0 = await page.evaluate(() => {
    const menu = document.querySelector("[role='menu']");
    const tabs = [...(menu?.querySelectorAll("button") ?? [])].filter((b) => /^(pi|dsh)$/i.test((b.textContent || "").trim()))
      .map((b) => ({ k: (b.textContent || "").trim(), disabled: b.disabled, title: b.title || "" }));
    // menuitem 带禁用态与可见性(inert 内核清单是 div 不占 menuitem 角色)
    const items = [...document.querySelectorAll("[role='menuitem']")].map((el) => ({
      t: (el.textContent || "").trim().slice(0, 30),
      disabled: el.getAttribute("aria-disabled") === "true",
      w: Math.round(el.getBoundingClientRect().width),
    }));
    return { tabs, items };
  });
  note("幕C 内核 TAB 态", JSON.stringify(c0.tabs));
  note("幕C 当前可见模型项", JSON.stringify(c0.items.slice(0, 6)));
  await page.keyboard.press("Escape");
  // 探针开的菜单必须等它真关掉——否则 pickModel 的触发器点击把已开的菜单 toggle 关掉(实测踩过)
  await page.waitForFunction(() => !document.querySelector("[role='menu']"), { timeout: 5000 }).catch(() => {});
  await pickModel("kimi-k3 dashscope", "dsh");
  ok(await setComposer("ping,只回 pong"), "幕C 输入框写入");
  ok(await clickSend(), "幕C 发送点击");
  await settle();
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 8000 }).catch(() => {});
  const c1 = await page.evaluate(() => {
    const body = document.body.innerText;
    return {
      hasError: body.includes("跨内核") || body.includes("已固定内核") || body.includes("未启动"),
      hasReply: /pong/i.test(body),
    };
  });
  note("幕C 出现内核切换错误", c1.hasError);
  note("幕C dsh 回复到达", c1.hasReply);
  ok(!c1.hasError && c1.hasReply, "幕C pi 会话在时新会话可切 dsh 模型并出回复(问题3 复现面)");
  await page.screenshot({ path: join(shotsDir, "C-newchat-dsh.png") });

  // ============ 幕D:dsh 会话真实切思考深度(补面全链路,dsh-thinking-level.md)============
  console.log("\n幕D: dsh 会话切思考深度(补面全链路)");
  // D1:档位下拉在 dsh 会话渲染(补面后 levels 来自扩展的精确模型清单)
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => /^(off|minimal|low|medium|high|xhigh|关|极简|低|中|高|极高|—)$/i.test((b.textContent || "").trim())),
    { timeout: 10000, polling: 300 },
  ).catch(() => {});
  const d1 = await page.evaluate(() => {
    const levelBtn = [...document.querySelectorAll("button")].find((b) => /^(off|minimal|low|medium|high|xhigh|关|极简|低|中|高|极高|—)$/i.test((b.textContent || "").trim()));
    const brain = [...document.querySelectorAll("button")].find((b) => (b.title || "").includes("思考"));
    return {
      levelDropdownText: levelBtn ? (levelBtn.textContent || "").trim() : null,
      brain: brain ? { title: brain.title, disabled: brain.disabled } : null,
    };
  });
  note("幕D 档位下拉当前值", d1.levelDropdownText);
  note("幕D 思考开关", JSON.stringify(d1.brain));
  ok(d1.levelDropdownText !== null, "幕D dsh 会话渲染思考档位下拉(补面生效)");
  // 探针锚点正值断言(data-composer-thinking,cwd-session-restore 那侧只证了"未起内核→缺席正确"):
  // 幕D 挑的模型**有** reasoning 面 → 档位控件必须在场,且锚**带值**(值即档位 id)。
  // 两处互为两面,合起来才说明"锚的存在性与清单一致"。
  const d1Anchor = await page.evaluate(() => document.querySelector("[data-composer-thinking]")?.getAttribute("data-composer-thinking") ?? null);
  note("幕D 档位锚值(切档前)", JSON.stringify(d1Anchor));
  // 断言"控件在场"(= 内核声明了非空档位清单)即可,别要求锚值非空——幕D 开场会话的档位是
  // **未选**(实测 currentLevel=""、思考已关闭),控件照样该在场。锚值是否跟上由 D2 断言。
  ok(d1Anchor !== null, `幕D 档位锚在场(= 内核声明了档位清单;值可为空串=未选,实际 ${JSON.stringify(d1Anchor)})`);
  // D2:开下拉选 low
  // 用探针锚定位档位控件(item 3 的收益):此前按文案匹配,而正则里的 `—` 是**模型选择器与
  // 档位选择器在空值时共用的占位符** → 会点中模型选择器、把会话切到别的模型(实测:幕D 本应是
  // dsh,点完却成了 pi:…/glm-5.2,composer 只剩一个按钮)。锚是唯一、无语义的定位面。
  await page.evaluate(() => {
    const btn = document.querySelector("[data-composer-thinking]");
    btn?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector("[role='menu']", { timeout: 5000 });
  const d2items = await page.evaluate(() => [...document.querySelectorAll("[role='menuitem']")].map((el) => (el.textContent || "").trim()));
  note("幕D 档位清单", JSON.stringify(d2items));
  ok(d2items.some((t) => /^(低|low)$/i.test(t)), "幕D 档位清单含 low/低(来自扩展的精确模型清单)");
  await page.evaluate(() => {
    const item = [...document.querySelectorAll("[role='menuitem']")].find((el) => (el.textContent || "").trim() === "低" || /^low$/i.test((el.textContent || "").trim()));
    item?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 6000 }).catch(() => {});
  // 切档后锚值必须跟上(skills §10.3.1:等待谓词 W = 断言谓词 X,不是"泛等一下就取样")。
  const d2AnchorOk = await page.waitForFunction(
    () => (document.querySelector("[data-composer-thinking]")?.getAttribute("data-composer-thinking") ?? "") === "low",
    { timeout: 8000, polling: 300 },
  ).then(() => true).catch(() => false);
  const d2AnchorVal = await page.evaluate(() => document.querySelector("[data-composer-thinking]")?.getAttribute("data-composer-thinking") ?? null);
  note("幕D 档位锚值(选 low 后)", JSON.stringify(d2AnchorVal));
  if (!d2AnchorOk) {
    // 失败留证据(skills §10.3.2):控件是"整条 composer 变了吗"还是"只有档位控件没了"?
    const diag = await page.evaluate(() => {
      const ta = document.querySelector("[data-timeline-composer]");
      const scope = ta?.closest("div")?.parentElement?.parentElement ?? document.body;
      return {
        modelAnchor: document.querySelector("[data-composer-model]")?.getAttribute("data-composer-model") ?? null,
        btns: [...scope.querySelectorAll("button")].map((b) => (b.textContent || "").trim().slice(0, 10)).filter(Boolean),
      };
    });
    note("幕D 现场", JSON.stringify(diag));
  }
  ok(d2AnchorOk, `幕D 选 low 后档位锚跟上(期望 low,实际 ${JSON.stringify(d2AnchorVal)})`);
  // D3:发送一条,下一请求的 request/header 带新档位 → 翻译器派生「思考强度 → low」分隔线
  ok(await setComposer("再说一遍 pong"), "幕D 输入框写入");
  ok(await clickSend(), "幕D 发送点击");
  await settle();
  await page.waitForFunction(() => document.body.innerText.includes("思考强度"), { timeout: 10000, polling: 300 }).catch(() => {});
  const d3 = await page.evaluate(() => document.body.innerText.includes("思考强度"));
  note("幕D 思考强度分隔线出现", d3);
  ok(d3, "幕D 切档后「思考强度 → low」分隔线落进会话流(request/header 派生,生效留痕)");
  await page.screenshot({ path: join(shotsDir, "D-dsh-thinking-switched.png") });

  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条${consoleTail[0] ? `: ${consoleTail[0].slice(0, 150)}` : ""})`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言通过;${notes.length} 条现状观察`);
  console.log("观察汇总:");
  for (const n of notes) console.log(`  - ${n}`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  console.error("观察汇总(截至失败):");
  for (const n of notes) console.error(`  - ${n}`);
  if (consoleTail.length) console.error(`console 错误尾巴:\n${consoleTail.slice(-8).join("\n")}`);
  await page.screenshot({ path: join(shotsDir, "fail.png") }).catch(() => {});
  console.error(`现场保留: ${runRoot}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
