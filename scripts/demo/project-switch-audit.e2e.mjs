#!/usr/bin/env node
// 切项目时**会话列表不得串台** —— DOM 混乱类缺陷的审计 e2e。
//
// 为什么单独立这一条：`sessions-list/renderer/index.tsx:505-512` 记着一个已修的根因——
//   「分组键 g.kind+g.label 跨项目高度重复(每个项目都有「今天」组)，切项目时 React 复用同一
//     GroupBlock 实例 + 拖拽库的内部状态残留 → 旧项目的 SortableRow 不卸载，列表里两个目录的
//     会话**叠加**(观感是「切项目后左侧根本不刷新」)」。
// 这类缺陷的特征是：功能"看起来能用"（列表有内容、能点），但内容是**两个项目混在一起的**——
// 正向剧本（在单个项目里发消息、看列表）永远撞不到它，只有**跨项目往返**才暴露。
// 而且它修过一次就可能再回来（键的构成很容易被"简化"回去），所以值得一条常驻剧本。
//
// 判据分三层，缺一不可：
//   ① **行数**：切到空项目就该是 0 行（残留旧项目的行 = 串台）；
//   ② **归属**：每一行 `data-session-path` 指向的文件必须真的存在，且属于**当前**项目；
//   ③ **往返**：切回来还能看到原来那些会话（不是"切走就丢了"）。
// 只验①会漏掉"行数对但内容是别的项目的"；只验③会漏掉"叠加"（叠加时切回来也还在）。
//
// 零 token：全程 minimal（echo 内核）。
//
// 用法: npm run build && node scripts/demo/project-switch-audit.e2e.mjs [--port 9400] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { clickPointUntil } from "./lib/interact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9400" }, keep: { type: "boolean", default: false } } });

let passed = 0;
const findings = [];
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}
function note(severity, kind, detail) { findings.push({ severity, kind, detail }); }

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
seedTestPlugins(ctx.dataRoot);

// 两个项目目录 + 预置 recentCwds（项目列表读的是插件全局配置 `projects.json`）
const dirA = join(home, "project-a");
const dirB = join(home, "project-b");
mkdirSync(dirA, { recursive: true });
mkdirSync(dirB, { recursive: true });
mkdirSync(ctx.configDir, { recursive: true });
writeFileSync(join(ctx.configDir, "projects.json"), JSON.stringify({ recentCwds: [dirA, dirB] }, null, 2));
const prefsFile = join(ctx.configDir, "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: dirA }, null, 2));
const neutralDir = join(ctx.dataRoot, "sessions");

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18461" }, timeoutMs: 90000 });
const page = app.page;
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
// 也收 console.error/warning：切项目的失败被插件 catch 成 console.error，只收 pageerror 看不见
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleErrors.push(m.text().slice(0, 200)); });

const readRows = () => page.evaluate(() => [...document.querySelectorAll("[data-session-path]")].map((el) => ({
  path: el.getAttribute("data-session-path"),
  text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
  group: el.closest("[data-session-group]")?.getAttribute("data-session-group") ?? null,
})));

const activeProject = () => page.evaluate(() => document.querySelector('[data-project-active="true"]')?.getAttribute("data-project-path") ?? null);

const switchToMinimal = async () => {
  const trig = await page.evaluate(() => {
    const b = document.querySelector("button[data-composer-model]");
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(trig.x, trig.y);
  await page.waitForSelector("[role='menu']", { timeout: 8000 });
  const switched = await clickPointUntil(
    page,
    () => {
      const tab = [...document.querySelectorAll("[role='menu'] button")].find((b) => (b.textContent || "").trim().toLowerCase() === "minimal");
      if (!tab) return null;
      const r = tab.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    () => [...document.querySelectorAll("[role^='menuitem']")].some((el) => (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0),
  );
  if (!switched) throw new Error("切不到 minimal 内核 TAB");
  const item = await page.evaluate(() => {
    const it = [...document.querySelectorAll("[role^='menuitem']")].find((el) => (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0);
    const r = it.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(item.x, item.y);
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 12000 }).catch(() => {});
};

const sendEcho = async (text) => {
  await page.click("[data-timeline-composer]");
  await page.keyboard.type(text);
  const r = await page.evaluate(() => {
    const b = document.querySelector("[data-composer-send]");   // r237：改用早就存在的稳定锚点（composer.tsx:573，r119 补的），不再按译文子串定位
    const rect = b.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(r.x, r.y);
  // ⚠ waitForFunction(fn, **options**, ...args)：options 在第二位（skill §17.11）
  const got = await page.waitForFunction(
    (t) => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(`[minimal echo] ${t}`)),
    { timeout: 60000, polling: 500 },
    text,
  ).then(() => true).catch(() => false);
  if (!got) throw new Error(`等不到 echo 回复：${text}`);
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 15000 }).catch(() => {});
};

const dumpProjects = () => page.evaluate(() => [...document.querySelectorAll("[data-project-path]")].map((el) => ({
  path: el.getAttribute("data-project-path"),
  active: el.getAttribute("data-project-active"),
  text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30),
  visible: el.getBoundingClientRect().width > 0,
})));

const clickProject = async (dir) => {
  // 真实点击（Radix/动画都要求可信输入），并等到 active 标记真的换过去
  await page.evaluate((d) => document.querySelector(`[data-project-path="${d}"]`)?.scrollIntoView({ block: "center" }), dir);
  // ⚠ 项目行同时挂了 dnd-kit 的拖拽 listeners（`{...listeners}`，PointerSensor + distance:4）
  //   与 React 的 onClick。实测**坐标点击不触发切换**（无控制台错误、cwd 不变、active 标记不动）：
  //   pointerdown 被拖拽传感器接管后，后续 click 没走到 React 的 onClick。
  //   改用合成 el.click() 直接派发 click——对这个元素指针路径已被拖拽占用，合成 click 是
  //   唯一能确定性触发 onClick 的方式。与 skill §3.2「优先可信点击」不冲突：那条讲的是
  //   Radix 菜单这类**依赖 isTrusted 的组件**；普通 React onClick 不看 isTrusted。
  //   （也别用 clickPointUntil：它内部固定走 page.mouse.click，没有"改用合成点击"的口子。）
  let done = false;
  for (let i = 0; i < 6 && !done; i++) {
    await page.evaluate((d) => document.querySelector(`[data-project-path="${d}"]`)?.click(), dir);
    await waitForDomIdle(page, { quietMs: 600, timeoutMs: 10000 }).catch(() => {});
    done = (await activeProject()) === dir;
  }
  if (!done) {
    console.log(`  · 切换失败诊断：项目列表=${JSON.stringify(await dumpProjects())}`);
    console.log(`  · 控制台错误/警告 ${consoleErrors.length} 条：${JSON.stringify(consoleErrors.slice(-4))}`);
    console.log(`  · 当前 cwd（renderer 视角）=${JSON.stringify(await page.evaluate(() => window.kernel?.prefs?.get?.("lastCwd") ?? null))}`);
    throw new Error(`切不到项目 ${dir}（active 标记没换过去）`);
  }
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});
};

/** 每行的归属核对 + **文件 ↔ DOM 的数量不变量**。
 *
 * ⚠ 对账的键要查清楚再写：中立层 header 的字段是
 *   `kernel / cwd / createdAt / lastEntryId / updatedAt / custom / lastMessage / name`
 *   ——**没有**会话文件路径字段（首版按 `header.sessionPath` 去匹配，5 行全部"找不到对应 header"，
 *   报出 5 条假 M 级发现）。header 与行的对应关系是靠 **cwd**：
 *   「`cwd` 等于当前项目的 header 份数」应当等于「当前列表可见行数」。
 *   这条不变量比逐行匹配路径更强：它同时抓住"多了"（串台/叠加）与"少了"（丢会话）。 */
const auditRowsBelongTo = async (dir, label) => {
  const rows = await readRows();
  const headers = existsSync(neutralDir)
    ? readdirSync(neutralDir).filter((f) => f.endsWith(".header.json"))
        .map((f) => JSON.parse(readFileSync(join(neutralDir, f), "utf-8")))
    : [];
  const mine = headers.filter((h) => h.header?.cwd === dir);
  console.log(`  · [${label}] 可见行 ${rows.length} 个；中立层 header 共 ${headers.length} 份，其中 cwd=本项目的 ${mine.length} 份`);
  for (const r of rows) {
    if (!r.path || r.path.startsWith("new:")) continue;
    if (!existsSync(r.path)) note("H", "会话行指向不存在的文件", `[${label}] ${r.path}`);
    // 内核侧路径里含**当前项目目录的 slug**（minimal 按 cwd 分子目录存会话），
    // 这是"这一行属于这个项目"的第二个独立证据（与 header.cwd 互不依赖）。
    const slug = dir.replace(/[^a-zA-Z0-9]/g, "-");
    if (!r.path.includes(slug)) {
      note("H", "会话行的内核侧路径不属于当前项目", `[${label}] path=${r.path.slice(-90)}`);
    }
  }
  return { rows, headers, mine };
};

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  ok((await activeProject()) === dirA, `起点在 A 项目（实际 ${await activeProject()}）`);
  // 激活态的可访问语义（r36 修：此前只靠 background/border 颜色表达，读屏听不出当前项目）
  const cur = await page.evaluate(() => [...document.querySelectorAll("[data-project-path]")].map((el) => ({
    path: el.getAttribute("data-project-path"),
    active: el.getAttribute("data-project-active"),
    current: el.getAttribute("aria-current"),
    role: el.getAttribute("role"),
  })));
  console.log(`  · 项目行 aria-current：${JSON.stringify(cur.map((c) => [c.path?.split("/").pop(), c.active, c.current, c.role]))}`);
  ok(cur.filter((c) => c.active === "true").every((c) => c.current === "true"),
    "激活项目的行带 aria-current=true（视觉态与可访问态同源）");
  ok(cur.filter((c) => c.active !== "true").every((c) => c.current === null),
    "非激活项目**不带** aria-current（不能全都标成当前）");
  console.log(`  · 项目列表：${JSON.stringify(await dumpProjects())}`);
  await switchToMinimal();

  // ---- A 项目里造两个会话 ----
  console.log("\n── A 项目：造两个会话 ──");
  await sendEcho("A 的第一个会话");
  await page.evaluate(() => document.querySelector("[data-session-new]").click());
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 10000 }).catch(() => {});
  // ⚠ 新会话的 composer **不继承**上一个会话的模型绑定（落回兜底 pi），必须重选 minimal
  if (!String(await page.evaluate(() => document.querySelector("[data-composer-model]")?.getAttribute("data-composer-model"))).startsWith("minimal:")) {
    await switchToMinimal();
  }
  await sendEcho("A 的第二个会话");

  const a = await auditRowsBelongTo(dirA, "A 项目");
  ok(a.rows.length >= 2, `A 项目列表至少两行（实际 ${a.rows.length}）`);
  const aTexts = a.rows.map((r) => r.text);
  ok(aTexts.some((t) => t.includes("A 的第一个会话")) && aTexts.some((t) => t.includes("A 的第二个会话")),
    `两行正是刚造的两个会话（${JSON.stringify(aTexts.map((t) => t.slice(0, 14)))}）`);
  ok(a.headers.length >= 2, `中立层至少两份 header（实际 ${a.headers.length}）`);
  ok(a.mine.length === a.rows.length, `A 项目：cwd=A 的 header 份数 == 可见行数（${a.mine.length} vs ${a.rows.length}）`);

  // ---- 切到 B（空项目）：必须 0 行，绝不能残留 A 的行 ----
  console.log("\n── 切到 B 项目（空）──");
  await clickProject(dirB);
  ok((await activeProject()) === dirB, "active 标记已切到 B");
  const b = await auditRowsBelongTo(dirB, "B 项目（空）");
  console.log(`  · B 项目下的行文本：${JSON.stringify(b.rows.map((r) => r.text.slice(0, 16)))}`);
  ok(b.rows.length === 0, `**空项目必须是 0 行**（实际 ${b.rows.length} 行 —— 有行就是 A 的会话串台/叠加）`);
  ok(b.mine.length === 0, `B 项目下 cwd=B 的 header 也应是 0 份（实际 ${b.mine.length}）——文件与 DOM 一致`);
  ok(b.headers.length >= 2, `A 的两份 header 仍在盘上（切项目不该删别人的会话；实际共 ${b.headers.length} 份）`);
  ok(!b.rows.some((r) => r.text.includes("A 的")), "B 项目下看不到任何 A 项目的会话（叠加缺陷的正面判据）");

  // ---- 在 B 里造一个会话 ----
  console.log("\n── B 项目：造一个会话 ──");
  if (!String(await page.evaluate(() => document.querySelector("[data-composer-model]")?.getAttribute("data-composer-model"))).startsWith("minimal:")) {
    await switchToMinimal();
  }
  await sendEcho("B 的唯一会话");
  const b2 = await auditRowsBelongTo(dirB, "B 项目（有一个会话）");
  ok(b2.rows.length >= 1, `B 项目列表至少一行（实际 ${b2.rows.length}）`);
  ok(b2.mine.length === b2.rows.length, `B 项目：cwd=B 的 header 份数 == 可见行数（${b2.mine.length} vs ${b2.rows.length}）`);
  ok(b2.rows.some((r) => r.text.includes("B 的唯一会话")), "那一行正是 B 的会话");
  ok(!b2.rows.some((r) => r.text.includes("A 的")), "B 项目下仍然看不到 A 的会话");

  // ---- 切回 A：原来两个会话还在，且不掺 B 的 ----
  console.log("\n── 切回 A 项目 ──");
  await clickProject(dirA);
  ok((await activeProject()) === dirA, "active 标记已切回 A");
  const a2 = await auditRowsBelongTo(dirA, "A 项目（往返后）");
  ok(a2.rows.length >= 2, `切回后 A 的两个会话还在（实际 ${a2.rows.length} 行）`);
  ok(a2.rows.some((r) => r.text.includes("A 的第一个会话")) && a2.rows.some((r) => r.text.includes("A 的第二个会话")),
    "切回后看到的正是原来那两个（不是『切走就丢』）");
  ok(!a2.rows.some((r) => r.text.includes("B 的唯一会话")), "A 项目下看不到 B 的会话（反向也不串台）");
  ok(a2.mine.length === a2.rows.length, `往返后 A：cwd=A 的 header 份数 == 可见行数（${a2.mine.length} vs ${a2.rows.length}）`);

  // ---- 中立层文件总数：三个会话都该在盘上（跨项目共存，不互相覆盖）----
  const allHeaders = readdirSync(neutralDir).filter((f) => f.endsWith(".header.json"));
  console.log(`\n── 文件侧总账 ──\n  · 中立层 header 共 ${allHeaders.length} 份`);
  ok(allHeaders.length >= 3, `三个会话（A 两个 + B 一个）都落了盘（实际 ${allHeaders.length} 份 header）`);

  ok(pageErrors.length === 0, `页面零报错（实际 ${pageErrors.length} 条${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ").slice(0, 160) : ""}）`);
} finally {
  await killApp(app);
}

console.log(`\n════ 审计发现（共 ${findings.length} 条）════`);
for (const f of findings) console.log(`  【${f.severity}】${f.kind}: ${f.detail}`);
console.log(`\n✅ 断言通过 ${passed} 项；审计发现 ${findings.length} 条（H=${findings.filter((f) => f.severity === "H").length}）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
if (findings.some((f) => f.severity === "H")) process.exitCode = 2;
