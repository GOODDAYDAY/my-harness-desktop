#!/usr/bin/env node
// 写盘失败必须**用户可见** e2e —— 构造真实的失败路径（r87）。
//
// ## 为什么需要这个剧本
//
// r80/r82/r83/r84/r86 连续五轮都在修同一类缺陷（服务端失败有两种形态：
// ① 返回 `{ok:false,error}`、② handler **抛错** ⇒ gateway 转 HANDLER_ERROR ⇒ transport **reject**
// ⇒ `await` **throw**；只处理①的调用点在②发生时**静默失败**），但每一轮都只能如实写
// "未真机目视"——因为构造真实失败需要让写盘/安装真的失败，而零 token 剧本里没有这个手段。
//
// r87 找到了手段：**把项目层配置文件设为只读**（`chmod 444` 文件 + `555` 目录），
// 然后在界面上做一次会触发布局持久化的操作（点右面板开关）。
// 于是 `writeGeneralConfig` → `configFile.setProject` 在服务端真的抛 EACCES，
// 完整走一遍"服务端 throw → gateway → transport reject → renderer .catch → announceTransient
// → 常驻 live region + 可见文本"。
//
// ⚠ **只读要设在项目层，不是全局层**：`writeGeneralConfig(patch, cwd)` 在有 cwd 时走
// `setProject(dir, "config/general.json", …)`，写的是 `<cwd>/.my-harness-desktop/config/general.json`。
// 首版把只读设在全局 `<dataRoot>/config/general.json` 上，结果写盘照样成功、探针报"无播报"——
// 那是**假阴性**（看起来像"修复无效"，实际是没造出失败）。
// > 通则：构造失败路径的剧本，**第一步要证明失败真的发生了**（这里靠播报文本里出现
// > `EACCES: permission denied` 与那个**具体路径**），否则"没有播报"既可能是修复无效、
// > 也可能是根本没造出失败——两者必须能区分。
//
// 零 token：不进会话、不发消息。
//
// 用法: npm run build && node scripts/demo/write-failure-feedback.e2e.mjs [--locale zh-CN|en] [--port 9760] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const { values: args } = parseArgs({
  options: {
    locale: { type: "string", default: "zh-CN" },
    port: { type: "string", default: "9760" },
    keep: { type: "boolean", default: false },
  },
});
const LOCALE = args.locale;
/** 各语言的预期文案片段（取自 system/i18n 的 shell.json，避免在剧本里另抄一份完整句子）。 */
const EXPECT = {
  "zh-CN": "布局保存失败",
  "zh-TW": "版面儲存失敗",
  en: "Failed to save layout",
  de: "Layout konnte nicht gespeichert",
};

let passed = 0;
function ok(cond, label, detail) {
  if (!cond) throw new Error(`断言失败: ${label}${detail !== undefined ? `（现场：${JSON.stringify(detail)?.slice(0, 300)}）` : ""}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const runRoot = makeRunRoot();
const home = join(runRoot, LOCALE);
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: LOCALE });
seedTestPlugins(ctx.dataRoot);
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(ctx.configDir, "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

const app = await launchApp({
  appDir: join(import.meta.dirname, "..", ".."),
  port: Number(args.port),
  env: { HOME: home, MHD_PORT: "18409" },
  timeoutMs: 90000,
});
const page = app.page;
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
// ⚠ 项目层配置目录（写盘目标）；unhandled rejection 也要收，因为"静默失败"的旧形态正是它
const unhandled = [];
process.on("unhandledRejection", (r) => unhandled.push(String(r).slice(0, 120)));

const pdir = join(projectDir, ".my-harness-desktop", "config");
const gen = join(pdir, "general.json");
try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 1000, timeoutMs: 25000 });

  console.log(`\n── 构造真实写盘失败（项目层配置只读）──`);
  mkdirSync(pdir, { recursive: true });
  if (!existsSync(gen)) writeFileSync(gen, "{}", "utf-8");
  chmodSync(gen, 0o444);
  chmodSync(pdir, 0o555);
  console.log(`  · 只读目标: ${gen.replace(home, "~")}`);

  const toggles = await page.$$("button[aria-pressed]");
  ok(toggles.length > 0, `右面板有开关可点（实际 ${toggles.length} 个）——没有就无法触发布局持久化`);
  await toggles[0].click();
  await new Promise((r) => setTimeout(r, 1400));   // 防抖 300ms + 服务端往返余量

  const out = await page.evaluate(() => {
    const hosts = [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')];
    const live = hosts.map((h) => ({ text: (h.textContent || "").trim(), role: h.getAttribute("role"), live: h.getAttribute("aria-live") })).filter((x) => x.text);
    const body = document.body.innerText || "";
    return { live, body };
  });

  console.log(`\n── 断言：失败必须用户可见（且带真实原因）──`);
  const all = [...out.live.map((l) => l.text), out.body].join("\n");
  const expectText = EXPECT[LOCALE] ?? EXPECT.en;
  ok(all.includes(expectText), `出现本语言的失败文案（期望含 ${JSON.stringify(expectText)}）`, all.slice(0, 200));
  // ⚠ 关键：**先证明失败真的发生了**，否则"没有播报"分不清是修复无效还是没造出失败
  ok(/EACCES|permission denied|EROFS/i.test(all), "播报里带**真实的底层错误**（EACCES/permission denied）⇒ 失败确实被造出来了，不是空跑");
  ok(all.includes("general.json"), "播报里点名了写盘失败的文件（用户/开发者能据此定位）");
  // 文案必须是译文，不能是裸键
  ok(!/shell\.layoutSaveFailed/.test(all), "界面显示的是**译文**而不是裸 i18n 键");
  // 进了常驻 live region（读屏可听），且错误用可打断的 role=alert
  console.log("  · live region 结构:", JSON.stringify(out.live.map((l) => ({ role: l.role, live: l.live, head: l.text.slice(0, 24) }))).slice(0, 300));
  const hosts = out.live.filter((l) => l.text.includes(expectText));
  ok(hosts.length > 0, "失败文案落在 live region 宿主里（读屏能听到）");
  // ⚠ 判"可打断"要看**任一**含该文案的元素，不能只看第一个匹配：
  //   r37 的常驻宿主本身是 role=status + aria-live=polite（外层），
  //   announceTransient 把 role=alert 设在**它追加的内层 span** 上（嵌套 live region，
  //   按 ARIA 内层对自己子树优先）。而 querySelectorAll 按文档序返回，外层先命中——
  //   首版就是这么假红的（看着像"错误没用 alert 播报"，实际是断言取错了元素）。
  ok(hosts.some((l) => l.role === "alert" || l.live === "assertive"),
    "错误用**可打断**的播报（内层 role=alert）——r59/r61 定的原则：播报强度属于语义");
  ok(hosts.some((l) => l.role === "status" || l.live === "polite"),
    "外层仍是常驻的 polite 宿主（r37 的形态：宿主先于内容存在，才能播报瞬时内容）");

  ok(pageErrors.length === 0, `页面零报错（实际 ${pageErrors.length} 条${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ").slice(0, 160) : ""}）`);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await page.screenshot({ path: join(runRoot, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  // 还原权限（否则清理临时目录会失败，留下垃圾）
  try { chmodSync(pdir, 0o755); chmodSync(gen, 0o644); } catch { /* 目录可能没建成 */ }
  await killApp(app);
}

console.log(`\n✅ PASS: ${passed} 项断言（写盘失败用户可见，locale=${LOCALE}）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
