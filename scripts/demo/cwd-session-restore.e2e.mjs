#!/usr/bin/env node
// 切项目 / 冷启动恢复会话 e2e —— 真实产物 + 隔离 HOME,验"切走再切回,上次看的会话还在"。
//
// 根因背景:projects.switchCwd 曾无条件 startNewChat + 清会话上下文 → 切项目永远给新会话,
// 浏览上下文全丢。修法=壳侧记 prefs.lastSessionByCwd(每个项目上次看的会话),切项目与冷启动
// 共用 restoreForCwd。本脚本用真实点击串起整条链路:
//   A) 首次访问(无记忆)→ 新会话壳;
//   B) 打开 B 的会话 → 切到 A(无记忆 → 新会话)→ 打开 A 的会话;
//   C) 再切回 B → 恢复 B 上次那个会话(核心断言);再切回 A → 恢复 A 的;
//   D) 点当前已激活项目 = 幂等 no-op(会话不变、不重开);
//   E) 真冷启动(杀进程重启) → 恢复 lastCwd 项目的会话;
//   F) 记忆指向悬空会话(会话被删/内容坏了在 store 眼里的形态) → 冷启动退新会话壳,不崩。
//
// 零 token(只读会话文件,不发送)。用法: npm run build && node scripts/demo/cwd-session-restore.e2e.mjs [--port 9362] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { writeSessionFile } from "./lib/seed/session-writer.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9362" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const MARK_A = "ALPHA-SESSION-MARKER";
const MARK_B = "BETA-SESSION-MARKER";
const NAME_A = "Alpha 会话";
const NAME_B = "Beta 会话";

const seedRows = (name, mark) => [
  { type: "message", message: { role: "user", stopReason: "end_turn", content: [{ type: "text", text: mark }] } },
  { type: "session_info", name },
  { type: "message", message: { role: "assistant", stopReason: "end_turn", content: [{ type: "text", text: `${mark}-REPLY` }] } },
];

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const dirA = join(home, "alpha");
const dirB = join(home, "beta");
for (const d of [dirA, dirB]) mkdirSync(d, { recursive: true });
ctx.writeConfig("projects", { recentCwds: [dirA, dirB] });
ctx.setPrefs({ lastCwd: dirA });
const fileA = writeSessionFile(ctx.agentDir, dirA, seedRows(NAME_A, MARK_A), 1, ctx.defaultModel);
const fileB = writeSessionFile(ctx.agentDir, dirB, seedRows(NAME_B, MARK_B), 1, ctx.defaultModel);
console.log(`  种子会话: A=${fileA}\n            B=${fileB}`);

const shotsDir = join(runRoot, "shots");
mkdirSync(shotsDir, { recursive: true });
let shotN = 0;
const shot = async (page, name) => {
  shotN += 1;
  await page.screenshot({ path: join(shotsDir, `${String(shotN).padStart(2, "0")}-${name}.png`) });
};

/** 时间线里有没有这条会话的内容(marker = 种子会话的首条 user 消息)。 */
const hasMarker = (page, mark) => page.evaluate(
  (m) => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(m)),
  mark,
);

/** 等某条会话的内容出现(事件驱动等 DOM 落位,不赌固定 sleep)。 */
const waitMarker = (page, mark, timeout = 20000) =>
  page.waitForFunction(
    (m) => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(m)),
    { timeout, polling: 300 },
    mark,
  ).then(() => true).catch(() => false);

const waitNoMarker = (page, mark, timeout = 8000) =>
  page.waitForFunction(
    (m) => ![...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(m)),
    { timeout, polling: 300 },
    mark,
  ).then(() => true).catch(() => false);

/** 真实鼠标点一个元素(§3.2 可信点击:走 CDP 命中测试,不 dispatch 合成事件)。 */
async function clickEl(page, selector, textIncludes) {
  const rect = await page.evaluate(({ sel, text }) => {
    const els = [...document.querySelectorAll(sel)];
    const el = text ? els.find((e) => (e.textContent || "").includes(text)) : els[0];
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, { sel: selector, text: textIncludes ?? null });
  if (!rect) throw new Error(`未找到可点元素: ${selector}${textIncludes ? ` (含「${textIncludes}」)` : ""}`);
  await page.mouse.click(rect.x, rect.y);
  return rect;
}

/** 切项目:点左栏项目行(ProjectRow 的 title = 完整路径)。 */
const switchTo = async (page, dir) => {
  await clickEl(page, `[data-sidebar-style] [title="${dir}"]`);
};

/** 打开某会话:点会话列表里标题含该名字的行。 */
const openSessionRow = async (page, name, timeout = 20000) => {
  await page.waitForFunction(
    (n) => [...document.querySelectorAll("[data-session-path]")].some((el) => (el.textContent || "").includes(n)),
    { timeout, polling: 300 },
    name,
  );
  await clickEl(page, "[data-session-path]", name);
};

/** 左栏会话列表里是否还有标题含该名字的行(切项目后旧项目的行必须消失)。 */
const hasRow = async (page, name) =>
  page.evaluate((n) => [...document.querySelectorAll("[data-session-path]")].some((el) => (el.textContent || "").includes(n)), name);

let app = null;
try {
  // ── 第一段:真实点击串(项目切换 + 恢复) ──
  app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18462" }, timeoutMs: 90000 });
  let page = app.page;
  const consoleTail = [];
  page.on("pageerror", (e) => consoleTail.push(e.message));

  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 探针锚点守卫(item 3「DOM 组装是否混乱」):e2e 探针必须能靠稳定锚定位,而不是按文本/子串猜。
  // 此前 project 行只有 title(绝对路径)、composer 模型/档位钮无锚,#19 的复现脚本正因
  // found:false 而误判「现象不存在」——纪律见 skills §10.3。
  const anchors = await page.evaluate(() => {
    const proj = [...document.querySelectorAll("[data-project-path]")].map((e) => e.getAttribute("data-project-path"));
    const modelEl = document.querySelector("[data-composer-model]");
    const thinkEl = document.querySelector("[data-composer-thinking]");
    return {
      projectRows: proj,
      modelAnchor: modelEl ? modelEl.getAttribute("data-composer-model") : null,
      thinkingPresent: thinkEl !== null,
    };
  });
  ok(anchors.projectRows.length >= 2, `项目行有 data-project-path 锚(实际 ${anchors.projectRows.length} 行)`);
  ok(anchors.projectRows.includes(dirA) && anchors.projectRows.includes(dirB), "锚值 = 项目绝对路径(可按 cwd 精确点选,不必拼 title)");
  ok(anchors.modelAnchor !== null, `composer 模型选择器有 data-composer-model 锚(值「${anchors.modelAnchor}」)`);
  // 档位控件是**条件渲染**(`levels.length > 0` 才画):未起内核 → 无清单 → 缺席是正确行为,
  // 而「缺席」本身就是「该内核没有档位」的可断言信号。**正值断言**(有清单 → 锚在且带值)
  // 落在起内核的 e2e(dsh-smoke)里——此处不写恒真断言(那等于没断言)。

  await shot(page, "cold-start-a-no-memory");

  // A) 首次访问 A(无记忆)→ 新会话壳:两个种子会话都没被打开
  ok(!(await hasMarker(page, MARK_A)) && !(await hasMarker(page, MARK_B)), "冷启动无记忆 → 新会话壳(未擅自打开任何历史会话)");

  // B) 切到 B(无记忆 → 新会话)→ 打开 B 的会话 → 切回 A → 打开 A 的会话
  await switchTo(page, dirB);
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 15000 });
  // 列表必须换成 B 的会话(根因守卫):此前 GroupBlock key=g.kind+g.label 跨项目重复,
  // React 复用实例 + dnd-kit 状态残留 → 旧项目的行不卸载,A 的会话与 B 的叠加
  // (观感「切项目后左侧根本不刷新」)。key 带 cwd 后旧行必须消失。
  ok(!(await hasRow(page, NAME_A)), "切到 B 后左栏不得残留 A 的会话行(旧行必须卸载)");
  ok(await hasRow(page, NAME_B), "切到 B 后左栏出现 B 的会话行");
  await openSessionRow(page, NAME_B);
  ok(await waitMarker(page, MARK_B), "打开 B 的会话 → 内容进入时间线(记忆写入的起点)");
  await shot(page, "b-session-open");

  await switchTo(page, dirA);
  ok(await waitNoMarker(page, MARK_B), "切到 A(无记忆)→ 新会话壳,不残留 B 的内容");
  await openSessionRow(page, NAME_A, 25000);
  ok(await waitMarker(page, MARK_A), "打开 A 的会话 → 内容进入时间线");
  await shot(page, "a-session-open");

  // C) 再切到 B → 恢复 B 上次那个会话(核心断言);再切回 A → 恢复 A 的
  await switchTo(page, dirB);
  ok(await waitMarker(page, MARK_B, 25000), "再切到 B → 恢复 B 上次看的会话(BETA,不是新会话)");
  await shot(page, "c-restored-b");

  await switchTo(page, dirA);
  ok(await waitMarker(page, MARK_A, 25000), "再切回 A → 恢复 A 上次看的会话(ALPHA)");

  // D) 点当前已激活项目 = 幂等 no-op
  await switchTo(page, dirA);
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 15000 });
  ok(await hasMarker(page, MARK_A), "点当前已激活的项目 = 幂等 no-op(会话不变,没被重开成新会话)");
  await shot(page, "d-idempotent-click");

  // ── 第二段:真冷启动(杀进程重启)→ 恢复 lastCwd 项目的会话 ──
  await killApp(app);
  app = null;
  app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18462" }, timeoutMs: 90000 });
  page = app.page;
  page.on("pageerror", (e) => consoleTail.push(e.message));
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  ok(await waitMarker(page, MARK_A, 25000), "真冷启动(重启进程)→ 恢复 lastCwd 项目(A)上次看的会话");
  await shot(page, "e-cold-start-restored");

  // ── 第三段:记忆指向的会话已不存在 → 冷启动退新会话壳 ──
  // 说明:删内核 JSONL 不足以让会话"消失"——壳有一份自己的中立层副本(数据根 sessions/
  // <id>.entries.json,openSession 从它读),所以这里直接把记忆改成悬空 id:这正是
  // "会话被删/内容坏了"在 store 眼里的形态(openSession 拿不到详情)。
  await killApp(app);
  app = null;
  ctx.setPrefs({
    lastCwd: dirA,
    lastSessionByCwd: { [dirA]: "no-such-session-id" },
  });
  app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18462" }, timeoutMs: 90000 });
  page = app.page;
  page.on("pageerror", (e) => consoleTail.push(e.message));
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  ok(!(await hasMarker(page, MARK_A)), "记忆指向悬空会话 → 冷启动退新会话壳(不报错、不留半开上下文)");
  const composerReady = await page.evaluate(() => !!document.querySelector("[data-timeline-composer]"));
  ok(composerReady, "退新会话后 app 仍可用(composer 在)");
  await shot(page, "f-stale-memory-fallback");

  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条:${consoleTail.slice(0, 2).join(" | ")})`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(切项目/冷启动恢复会话,零 token)`);
  console.log(`   截图: ${shotsDir}`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  if (args.keep) console.error(`   现场保留: ${runRoot}`);
  if (app) await killApp(app).catch(() => {});
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(1);
}
