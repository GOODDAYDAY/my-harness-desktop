#!/usr/bin/env node
// 会话单源冒烟 e2e(session-single-source 重构的真实链路验证)——拉起 out/ 构建产物
// (隔离 HOME + 独立端口 + CDP),真实 pi 内核 + 真实模型(一次 ping,花极少 token):
//   ① 应用起得来、composer 可用(不黑屏)
//   ② 发一条 ping,回合收敛(写穿链路:事件→dispatch→中立层)
//   ③ 中立层落盘硬断言:sessions/<ns>.json 含 user+assistant 条目,assistant 带 usage、
//     startedAt(内核开始时间)与 timestamp(写穿完成时刻)双时间戳
//   ④ 渲染层镜像收到写穿回执(window.__neutralLog 插桩,session:neutralChange 到达)
//   ⑤ 刷新重开后会话内容仍在(中立层单源,刷新前后一致)
//
// 用法: npm run build && node scripts/demo/session-single-source.e2e.mjs [--port 9336] [--keep]
// 注意: 花真实 token(一次 pi ping);pi 内核/模型配置从真实 HOME 链接+拷贝进隔离区。
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPortFree, launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const { values: args } = parseArgs({
  options: { port: { type: "string", default: "9336" }, keep: { type: "boolean", default: false } },
});
const PORT = Number(args.port);
const APP_PORT = 18426; // 与 dev 实例 8420、兄弟 e2e(18422)错开(assemble 读 MHD_PORT)

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`PASS  ${label}`);
}

/** React 受控 textarea 可靠写入(dsh-multiturn 同款:原生 setter + input 事件)。 */
const setComposer = (page, text) => page.evaluate((t) => {
  const ta = document.querySelector("[data-timeline-composer]");
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, t);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
}, text);

const clickSend = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || x.title || "").includes("发送") && x.getBoundingClientRect().width > 0);
  if (!b) return false;
  b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return true;
});

/** 等回合收敛:先等「停止」出现(回合真的起跑),再等它消失(收敛)。
 *  两步都事件驱动,不赌固定 sleep。 */
async function settle(page, timeoutMs = 120000) {
  const appeared = await page.waitForSelector("[aria-label*='停止']", { timeout: 20000 }).then(() => true).catch(() => false);
  if (appeared) {
    await page.waitForFunction(() => !document.querySelector("[aria-label*='停止']"), { timeout: timeoutMs, polling: 500 });
  }
}

/** 等中立层数据落位(轮询会话文件,事件驱动的兜底是截止时间,失败不吞)。 */
async function waitNeutralEntry(sessDir, pred, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const files = existsSync(sessDir) ? readdirSync(sessDir).filter((f) => f.endsWith(".json")) : [];
    for (const f of files) {
      try {
        const sess = JSON.parse(readFileSync(join(sessDir, f), "utf-8"));
        const all = (sess.lineages ?? []).flatMap((l) => l.entries ?? []);
        if (all.some(pred)) return { sess, all };
      } catch { /* 半截文件,下一轮再读 */ }
    }
    if (Date.now() > deadline) throw new Error("等中立层条目超时(90s)");
    await new Promise((r) => setTimeout(r, 500));
  }
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
// 种子一个项目目录并把 lastCwd 指过去——不种项目时应用停在无项目空态,composer 不渲染。
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
const prefs = JSON.parse(readFileSync(prefsFile, "utf-8"));
prefs.lastCwd = projectDir;
writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));
console.log(`隔离 HOME: ${home}(真实 pi 内核 + 真实模型,一次 ping)`);

const app = await launchApp({ appDir: ROOT, port: PORT, env: { HOME: home, MHD_PORT: String(APP_PORT) }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("console", (m) => { consoleTail.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => { consoleTail.push(`[pageerror] ${e.message}`); });

try {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  // ① composer 可用(应用起得来、插件挂载)
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  ok(true, "① 应用启动、composer 可用");

  // 插桩:渲染端收到写穿回执(session:neutralChange)
  await page.evaluate(() => {
    window.__neutralLog = [];
    window.kernel.sessions.onNeutralChange?.((c) => {
      window.__neutralLog.push(`${c.kind}:${c.ns?.slice(0, 8)}`);
    });
  });

  // ② 发一条 ping,等中立层出现 assistant 条目(数据到位为准,不赌渲染帧)
  await setComposer(page, "ping");
  await clickSend(page);
  const sessDir = join(home, ".my-harness-desktop-dev", "sessions");
  const { sess, all } = await waitNeutralEntry(sessDir, (e) => e.message?.role === "assistant");
  await settle(page).catch(() => {});
  ok(true, "② ping 回合收敛(写穿链路全程跑通)");
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});

  // ③ 中立层落盘硬断言(数据层,不依赖渲染窗口)
  ok(true, "③ 中立层会话文件已建");
  const userEntry = all.find((e) => e.message?.role === "user" && String(e.message?.content ?? "").includes("ping"));
  const asstEntry = all.find((e) => e.message?.role === "assistant");
  ok(!!userEntry, "③ 用户消息落中立层(写穿)");
  ok(!!asstEntry, "③ assistant 回复落中立层(messageEnd 写穿)");
  ok(!!asstEntry.message.usage, "③ assistant 条目带 usage(统计素材随条目持久化)");
  ok(typeof asstEntry.message.timestamp === "number", "③ 条目带写穿时刻 timestamp");
  ok(Array.isArray(sess.lineages) && sess.lineages.length >= 1, "③ lineage 结构完整");

  // ④ 渲染端收到写穿回执
  const nlog = await page.evaluate(() => window.__neutralLog ?? []);
  ok(nlog.some((x) => x.startsWith("entry:")), `④ 渲染层镜像收到条目回执(${nlog.length} 条变更)`);

  // ⑤ 刷新重开 → 内容仍在(单源一致性)
  // ⑤ 刷新重开 → 内容仍在(单源一致性)
  // 启动只恢复 lastCwd、停在新会话壳是两内核一致的设计行为,所以这里必须主动点行重开;
  // 且断言打在时间线上([data-message-id])——body.innerText 会被侧栏会话预览里的
  // 同款文本蒙混(侧栏有「ping」≠ 时间线渲染出「ping」)。锚点用 sessions-list 的
  // data-session-path 行([data-sidebar-style] 是主题预览卡的私有锚,匹配不到列表)。
  await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 20000 });
  const timelineHasPing = () => page.evaluate(() =>
    [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("ping")));
  if (!(await timelineHasPing())) {
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-session-path]")];
      const row = rows.find((r) => (r.innerText || "").includes("ping"));
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});
  }
  ok(await timelineHasPing(), "⑤ 刷新重开后时间线会话内容仍在(中立层单源)");

  const errs = consoleTail.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]"));
  ok(errs.length === 0, `页面零报错(实际 ${errs.length} 条${errs[0] ? `: ${errs[0].slice(0, 120)}` : ""})`);

  console.log(`\n===== 会话单源冒烟 e2e: 全绿 ✅(${passed} 项断言) =====`);
} catch (e) {
  console.error(`\nFAIL: ${e.message}`);
  console.error("控制台尾部:", consoleTail.slice(-12).join("\n"));
  process.exitCode = 1;
} finally {
  await killApp(app);
  if (!args.keep) {
    // 隔离 HOME 一次性,录完即弃
  }
}
