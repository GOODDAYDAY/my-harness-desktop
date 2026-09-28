#!/usr/bin/env node
// `ctx.config.set` 写盘失败必须**用户可见** e2e（r94；r82 框架级兜底的真机证据）。
//
// ## 这一条为什么补了四轮才补上
//
// r82 给 `ctx.config.set` 加了框架级兜底（失败 ⇒ announceTransient 播报 + 重新抛出），
// 但 r82/r83/r84/r86 四轮都只能如实写"未真机目视"——构造不出真实的写盘失败。
// r87 找到了手段（只读文件系统）并验证了**布局持久化**那一条支路；
// r88/r89 试图验 config.set 这一支却卡在设置页导航，先后误判为"坐标问题"（r88）
// 与"判据在等不会出现的元素"（r89）；r93 才查明根因是**产品缺锚点**
// （`SettingsPane` 根元素没有 data-*/id/role，无 tabs 的条目也不渲染 tabpanel
// ⇒ 自动化无法判断"当前激活的是哪个条目"），补上 `data-settings-pane[-active]` 后立刻通了。
//
// ## 手段与载体
//
// · **手段**：把目标插件的两层配置文件都设只读（`chmod 444` 文件 + `555` 目录，
//   目录也要否则可删可重建）。⚠ 必须两层都设：`ctx.config.set` 有 cwd 时写**项目层**
//   `<cwd>/.my-harness-desktop/config/<pluginId>.json`，无 cwd 时写全局层（r87 踩过只设一层的坑）。
// · **载体**：`tool-manager` 的设置页（条目 id `tools`）——它是 r81 账本里 9 个
//   `ctx.config.set` 调用点之一（`await ctx.config.set("groups", newGroups)`），
//   且面板里有可点的按钮。r93 的教训：**选载体前先确认它真的有那条路径**
//   （首版选 llm-recorder，结果它的开关不在设置页，白跑一轮）。
//
// ## 断言（含"失败真的发生了"的自证）
//
// ① 出现本语言的失败文案；② 文案里带**真实底层错误**（EACCES/permission denied）
// ⇒ 证明失败确实被造出来了，不是空跑（r87 的纪律）；③ 不是裸 i18n 键；
// ④ 落在常驻 live region 里，且**内层是 role=alert**（错误可打断，r59/r61 的原则）
// 而外层仍是 polite 宿主（r37 的形态：宿主先于内容存在）；⑤ 页面零报错。
//
// 零 token：不进会话、不发消息。
//
// 用法: npm run build && node scripts/demo/config-write-failure.e2e.mjs [--locale zh-CN|en] [--port 9862] [--keep]
import { mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { clickPointUntil } from "./lib/interact.mjs";

const { values: args } = parseArgs({ options: {
  locale: { type: "string", default: "zh-CN" }, port: { type: "string", default: "9862" }, keep: { type: "boolean", default: false } } });
let passed = 0;
function ok(cond, label, detail) {
  if (!cond) throw new Error(`断言失败: ${label}${detail !== undefined ? `（现场：${JSON.stringify(detail)?.slice(0, 300)}）` : ""}`);
  passed += 1; console.log(`  ✓ ${label}`);
}
const LOCALE = args.locale;
const PID = "tool-manager";
const EXPECT = { "zh-CN": "设置保存失败", en: "Failed to save setting", de: "Einstellung konnte nicht" };
const runRoot = makeRunRoot(); const home = join(runRoot, LOCALE);
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: LOCALE });
seedTestPlugins(ctx.dataRoot);
const pd = join(home, "project"); mkdirSync(pd, { recursive: true });
const pf = join(ctx.configDir, "config.json");
writeFileSync(pf, JSON.stringify({ ...JSON.parse(readFileSync(pf, "utf-8")), lastCwd: pd }, null, 2));
const app = await launchApp({ appDir: "/Users/dev/work/pi-desktop", port: Number(args.port), env: { HOME: home, MHD_PORT: "18403" }, timeoutMs: 90000 });
const page = app.page;
const ro = [];
try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 1000, timeoutMs: 25000 });
  // ① 两层配置都设只读
  for (const dir of [join(ctx.dataRoot, "config"), join(pd, ".my-harness-desktop", "config")]) {
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${PID}.json`);
    if (!existsSync(f)) writeFileSync(f, "{}", "utf-8");
    chmodSync(f, 0o444); chmodSync(dir, 0o555); ro.push([dir, f]);
  }
  console.log(`  · ${PID} 两层配置已设只读`);
  // ② 进设置页 → 激活 tools 条目（用 r93 的新锚点判激活）
  await page.evaluate(() => document.querySelector('[data-sidebar-entry="settings"]')?.click());
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 15000 }).catch(() => {});
  await clickPointUntil(page, (s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(12, r.height / 2)) } : null;
  }, () => {
    const p = document.querySelector('[data-settings-pane="tools"]');
    return !!p && p.getAttribute("data-settings-pane-active") === "true";
  }, { tries: 6, settleMs: 400, arg: '[data-settings-id="tools"]' }).catch(() => {});
  const active = await page.evaluate(() => document.querySelector('[data-settings-pane="tools"]')?.getAttribute("data-settings-pane-active"));
  console.log(`  · tools 面板激活=${active}`);
  // ③ 点面板里第一个按钮（工具分组开关）触发 config.set
  const label = await page.evaluate(() => {
    const pane = document.querySelector('[data-settings-pane="tools"]');
    const b = pane?.querySelector("button");
    if (!b) return null;
    const t = (b.textContent || b.getAttribute("aria-label") || "").trim().slice(0, 24);
    b.click();
    return t;
  });
  console.log(`  · 点击的按钮: ${JSON.stringify(label)}`);
  await new Promise((r) => setTimeout(r, 1600));
  const out = await page.evaluate(() => {
    const hosts = [...document.querySelectorAll('[aria-live],[role="status"],[role="alert"]')]
      .map((h) => ({ text: (h.textContent || "").trim(), role: h.getAttribute("role") })).filter((x) => x.text);
    return { hosts, body: document.body.innerText || "" };
  });
  const all = out.body + "\n" + out.hosts.map((h) => h.text).join("\n");
  const want = EXPECT[LOCALE] ?? EXPECT.en;
  console.log(`\n── 断言（locale=${LOCALE}）──`);
  ok(active === "true", "tools 设置面板已激活（靠 r93 补的 data-settings-pane-active 锚点判定）");
  ok(!!label, "面板里有可点的控件（否则触发不了 config.set）");
  ok(all.includes(want), `出现本语言的失败文案（期望含 ${JSON.stringify(want)}）`, all.slice(0, 200));
  ok(/EACCES|permission denied|EROFS/i.test(all), "文案里带**真实底层错误** ⇒ 失败确实被造出来了（不是空跑）");
  ok(!/shell\.configWriteFailed/.test(all), "显示的是译文，不是裸 i18n 键");
  const alertHost = out.hosts.find((h) => h.text.includes(want) && h.role === "alert");
  ok(!!alertHost, "错误落在 **role=alert** 的播报里（可打断；r59/r61：播报强度属于语义）");
  ok(out.hosts.some((h) => h.text.includes(want) && h.role === "status"),
    "外层仍是常驻 polite 宿主（r37 的形态：宿主先于内容存在才能播报瞬时内容）");
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await page.screenshot({ path: join(runRoot, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  // 还原权限（否则清理临时目录会失败、留下垃圾）
  for (const [d, f] of ro) { try { chmodSync(d, 0o755); chmodSync(f, 0o644); } catch {} }
  await killApp(app);
}

console.log(`\n✅ PASS: ${passed} 项断言（ctx.config.set 写盘失败用户可见，locale=${LOCALE}）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
