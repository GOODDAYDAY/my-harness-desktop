#!/usr/bin/env node
// 会话行**拖拽排序 → customOrder 落盘 → 重启后仍在** 的对账审计 e2e。
//
// 这是"文件 ↔ DOM 对账"里最难的一类，难在两端都不好办：
//   · **交互端**：拖拽。本仓的排序控件是 framer-motion `Reorder`
//     （`packages/react/src/widgets/sortable-list.tsx`），且 `dragListener={false}`——
//     拖拽只由自定义 `onPointerDown` 启动（`preventDefault()` 后 `controls.start(e)`），
//     并且**落在 `input,textarea,button,[contenteditable]` 上时不启动**。
//     所以 pointerdown 必须打在行的非按钮区域，否则"拖不动"看起来像产品坏了。
//   · **落盘端**：`onDragEnd` → `persistOrder()` → `ctx.config.set("customOrder", …)`
//     （默认项目级 → `<cwd>/.my-harness-desktop/config/sessions-list.json`）。
//     它存的是 **groupId → path 数组**，重载后由纯函数 `applyCustomOrder` 重建顺序。
//
// 判据三层：① 拖完 DOM 顺序真的变了；② 配置文件里的 `customOrder[groupId]` 与新 DOM 顺序**一致**；
// ③ **重启应用后顺序还在**（这条最硬——它同时证明"落盘了"与"读回来并真的用上了"，
// 只验①②会漏掉"写了文件但重载时没人读/读了没应用"）。
//
// 顺带验一条降级：搜索态下拖拽被禁（`SortableList disabled`）——搜索结果是过滤子集，
// 在子集里重排会把错误的顺序写回完整列表（源码注释：「过滤子集里重排会写回错误的 order」）。
//
// 零 token：全程 minimal（echo 内核）。
//
// 用法: npm run build && node scripts/demo/session-order-audit.e2e.mjs [--port 9410] [--keep]
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
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9410" }, keep: { type: "boolean", default: false } } });

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
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(ctx.configDir, "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));
/** 项目级插件配置（`ctx.config.set` 不带 scope 时的默认落点）。 */
const projectConfigDir = join(projectDir, ".my-harness-desktop", "config");
/** 中立层会话头目录（header 里带 cwd/name/kernel 等，是文件↔DOM 对账的"文件"那一侧）。 */
const neutralDir = join(ctx.dataRoot, "sessions");
const orderFileCandidates = [
  join(projectConfigDir, "sessions-list.json"),
  join(ctx.configDir, "sessions-list.json"),
];

const readOrderFile = () => {
  for (const p of orderFileCandidates) {
    if (existsSync(p)) return { path: p, json: JSON.parse(readFileSync(p, "utf-8")) };
  }
  return { path: null, json: null };
};

let app = null;
let page = null;
const pageErrors = [];

const boot = async (port, mhdPort) => {
  app = await launchApp({ appDir: ROOT, port, env: { HOME: home, MHD_PORT: mhdPort }, timeoutMs: 90000 });
  page = app.page;
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
};

/** 列表当前顺序：按 DOM 出现序取每行的 path 与所属分组。 */
const readOrder = () => page.evaluate(() => [...document.querySelectorAll("[data-session-path]")].map((el) => ({
  path: el.getAttribute("data-session-path"),
  group: el.closest("[data-session-group]")?.getAttribute("data-session-group") ?? null,
  text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 26),
})));

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
    const b = document.querySelector("button[aria-label*='发送']");
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
  // 新会话不继承模型绑定，下一条发送前要重选（skill §17.13）
  await page.evaluate(() => document.querySelector("[data-session-new]")?.click());
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 10000 }).catch(() => {});
  if (!String(await page.evaluate(() => document.querySelector("[data-composer-model]")?.getAttribute("data-composer-model"))).startsWith("minimal:")) {
    await switchToMinimal();
  }
};

/**
 * 拖拽一行到另一行的位置。
 * ⚠ pointerdown 必须落在**行的非按钮区域**：`sortable-list.tsx` 的 onPointerDown 里有
 *   `if (e.target.closest("input,textarea,button,[contenteditable]")) return;`
 *   ——打在行内按钮上根本不会启动拖拽，症状是"拖不动"，看起来像产品坏了。
 *   取行矩形**左边缘内侧**一小段（图标区左边距），避开右侧的动作按钮群。
 */
// ⚠ 按 **path** 定位，不按索引：`[data-session-path]` 的原始集合里**含「新对话」占位行**，
//   而调用方手里的顺序数组是过滤过的——用过滤后数组的下标去索引未过滤的集合会**差一位**
//   （首版就是这么把"排序乙"拖向"新对话"，于是看起来像"拖拽没生效"）。
const dragRow = async (fromPath, toPath) => {
  const pts = await page.evaluate(({ f, t }) => {
    const rows = [...document.querySelectorAll("[data-session-path]")];
    const pick = (el) => {
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + 12, y: r.y + r.height / 2 };      // 左边缘内侧 12px：避开按钮
    };
    const a = rows.find((el) => el.getAttribute("data-session-path") === f);
    const b = rows.find((el) => el.getAttribute("data-session-path") === t);
    return a && b ? { from: pick(a), to: pick(b) } : null;
  }, { f: fromPath, t: toPath });
  if (!pts) throw new Error(`行不存在：${fromPath?.slice(-20)} → ${toPath?.slice(-20)}`);
  await page.mouse.move(pts.from.x, pts.from.y);
  await page.mouse.down();
  // 分步移动：framer-motion 靠 pointermove 序列算位移，一步跳过去常常识别不出拖拽
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      pts.from.x + ((pts.to.x - pts.from.x) * i) / steps,
      pts.from.y + ((pts.to.y - pts.from.y) * i) / steps,
    );
    await new Promise((r) => setTimeout(r, 16));
  }
  await page.mouse.up();
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});
};

try {
  await boot(Number(args.port), "18459");
  await switchToMinimal();

  // ---- 造三个会话（同一时间档，才会落在同一个分组里，才有"组内排序"可言）----
  console.log("\n── 造三个会话 ──");
  await sendEcho("排序甲");
  await sendEcho("排序乙");
  await sendEcho("排序丙");
  // 第三次 sendEcho 之后已点了新建，这里不再发；收掉可能的空壳新会话态
  const allRows = await readOrder();
  console.log(`  · 全部行：${allRows.map((r) => `${r.group ?? "∅"}:${r.text.slice(0, 8)}`).join(" → ")}`);
  // ⚠ 首行可能是「新对话」**乐观占位行**（path 形如 `new:<cwd>`、不在任何分组里，group=null）。
  //   它不是会话，必须排除——首版直接取 order[0].group 拿到 null，于是"三行同组"断言必然红
  //   （skill §2 早记过这条：`rows[0]` 会点到空壳，我又踩了一次）。
  let order = allRows.filter((r) => r.path && !r.path.startsWith("new:") && r.group);
  console.log(`  · 真会话行 ${order.length} 个；分组：${JSON.stringify([...new Set(order.map((r) => r.group))])}`);
  ok(order.length >= 3, `至少三个真会话行（实际 ${order.length}）`);
  // 取**行数最多**的那个分组（三个会话同一时刻造出来，理应同在一个时间档）
  const byGroup = {};
  for (const r of order) (byGroup[r.group] ??= []).push(r);
  const group = Object.entries(byGroup).sort((a, b) => b[1].length - a[1].length)[0][0];
  const sameGroup = byGroup[group];
  ok(sameGroup.length >= 3, `三行落在同一分组「${group}」内（实际 ${sameGroup.length}）——跨组不产生组内序`);

  const before = readOrderFile();
  console.log(`  · 拖拽前配置文件：${before.path ?? "（尚未生成）"}${before.json ? ` customOrder=${JSON.stringify(before.json.customOrder ?? null)}` : ""}`);

  // ---- 搜索态：拖拽必须被禁（过滤子集里重排会写回错误的 order）----
  console.log("\n── 搜索态禁拖 ──");
  await page.evaluate(() => document.querySelector("[data-session-search]").click());
  await page.waitForSelector("[data-session-search-input]", { timeout: 8000 });
  await page.click("[data-session-search-input]");
  await page.keyboard.type("排序甲");
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 12000 }).catch(() => {});
  // ⚠ 打完字要**回读输入框的值**确认（r22 的教训），否则"没打到"会伪装成"过滤坏了"
  const typedQ = await page.evaluate(() => document.querySelector("[data-session-search-input]")?.value ?? null);
  ok(typedQ === "排序甲", `搜索框里确实是「排序甲」（实际 ${JSON.stringify(typedQ)}）`);
  const searchGroups = await page.evaluate(() => [...document.querySelectorAll("[data-session-group]")].map((g) => g.getAttribute("data-session-group")));
  const searchRows = await readOrder();
  console.log(`  · 搜索态分组：${JSON.stringify(searchGroups)}；命中 ${searchRows.length} 行`);
  // ★ 先断言**非空**再断言内容：`[].every(...)` 恒真，直接 every 会把"一个分组都没有"判成通过
  //   （首版正是这样假绿的：搜索态分组查出来是 []，断言却过了）。
  ok(searchGroups.length > 0, `搜索态下确有分组元素（实际 ${searchGroups.length} 个 —— 为 0 说明查询或渲染没发生，判据会空转）`);
  ok(searchGroups.every((g) => g === "search"), `搜索态下只有 search 分组（实际 ${JSON.stringify(searchGroups)}）`);
  ok(searchRows.length === 1, `搜索命中 1 行（实际 ${searchRows.length}）——过滤真的生效`);
  // ⚠ 这里**不能**用"拖一下看列表变不变"来验：CDP 驱动不了 framer-motion 的拖拽
  //   （见下面「文件 → DOM」那段的诊断留档），所以无论禁没禁拖，结果都是"unchanged"——
  //   那是条**恒真断言**（§17.2 第 7 种假绿）。改成验**结构**：
  //   `sortable-list.tsx` 里 `style={{ cursor: disabled ? undefined : "grab" }}`，
  //   所以"拖拽被禁"在 DOM 上的可观测后果是 Reorder.Item 的 cursor **不是** grab。
  const cursors = await page.evaluate(() => [...document.querySelectorAll("[data-session-path]")]
    .filter((el) => !el.getAttribute("data-session-path").startsWith("new:"))
    .map((el) => {
      // Reorder.Item 是行的祖先里那个带 `position:relative; list-style:none` 的 div
      let n = el.parentElement;
      while (n && !/list-style:\s*none/.test(n.getAttribute("style") ?? "")) n = n.parentElement;
      return n ? getComputedStyle(n).cursor : null;
    }));
  console.log(`  · 搜索态下 Reorder.Item 的 cursor：${JSON.stringify(cursors)}`);
  ok(cursors.length > 0, `找到了 Reorder.Item 元素（${cursors.length} 个）——否则这条判据空转`);
  ok(cursors.every((c) => c !== "grab"), `搜索态下拖拽被禁（cursor 不是 grab；实际 ${JSON.stringify([...new Set(cursors)])}）`);
  // 退出搜索
  await page.evaluate(() => {
    const el = document.querySelector("[data-session-search-input]");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.keyboard.press("Escape");
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 12000 }).catch(() => {});
  order = await readOrder();
  ok(order.length >= 3, `退出搜索后列表恢复（${order.length} 行）`);
  // 反向也要验：退出搜索后 cursor 应回到 grab——否则"搜索态禁拖"可能是"一直禁着"，
  // 那这条降级就把正常功能也一起关掉了（§11.7「降级要成对验：隐藏对 + 不过度降级」）。
  const cursorsAfter = await page.evaluate(() => [...document.querySelectorAll("[data-session-path]")]
    .filter((el) => !el.getAttribute("data-session-path").startsWith("new:"))
    .map((el) => {
      let n = el.parentElement;
      while (n && !/list-style:\s*none/.test(n.getAttribute("style") ?? "")) n = n.parentElement;
      return n ? getComputedStyle(n).cursor : null;
    }));
  console.log(`  · 退出搜索后 cursor：${JSON.stringify([...new Set(cursorsAfter)])}`);
  ok(cursorsAfter.some((c) => c === "grab"), "退出搜索后拖拽恢复可用（cursor 回到 grab）——降级没有过度" );

  // ---- ② 文件 → DOM：预置 customOrder，重启后列表必须按文件里的顺序渲染 ----
  //
  // ⚠ **为什么不用指针拖拽来驱动**：实测过（诊断留档）——CDP 的鼠标事件是**可信**的
  //   （`isTrusted:true, pointerId:1, isPrimary:true, pointerType:"mouse"`），落点也正确
  //   （`Reorder.Item` 确实在祖先链上：`position:relative; cursor:grab; list-style:none`），
  //   但 framer-motion 的拖拽**没有启动**：拖拽中途元素的 `transform`/`zIndex`/`boxShadow`
  //   全是默认值（`whileDrag` 样式没生效），松手后顺序不变。硬凑会得到一个偶发剧本，
  //   所以把这条链**分层覆盖**：
  //     · "顺序如何被重排"的算法 → 圆心纯函数单测 `domain/custom-order.test.ts`（8 条）；
  //     · "文件里的顺序 → DOM 顺序"的读回路径 → 下面这段（预置文件 + 重启 + 断言，确定性）；
  //     · "拖拽 → 写文件"这一段 → 需要人工用 `MHD_WINDOW=shown` 复核，剧本不假装能做。
  console.log("\n── 文件 → DOM：预置 customOrder 后重启 ──");
  const groupRows = order.filter((r) => r.group === group);
  // customOrder 的 value 是 `neutralSessionId ?? path`（见 GroupBlock 的 ids 计算），
  // 所以要从 header 文件里取 ns，不能拿 data-session-path 直接当 key。
  // customOrder 的 key 是 `neutralSessionId ?? path`（GroupBlock 里
  //   `ids = orderedItems.map((s) => s.neutralSessionId ?? s.path)`），所以必须用 **ns** 当 key。
  // ⚠ 别想从 header 文件反查：中立层 header 的字段是
  //   `kernel/cwd/createdAt/lastEntryId/updatedAt/custom/lastMessage/name`——**没有内核侧路径**，
  //   path→ns 对不上（首版就是这么种的，一个 key 都没匹配上 → 全部落进 rest → 顺序没变，
  //   看起来像"落盘没被读回来"）。正确来源是 IPC 的会话清单，它两个字段都带。
  const listRows = await page.evaluate((cwd) => window.kernel.sessions.list(cwd), projectDir);
  const nsByPath = new Map();
  for (const r of Array.isArray(listRows) ? listRows : []) {
    if (r?.path && r?.neutralSessionId) nsByPath.set(r.path, r.neutralSessionId);
  }
  console.log(`  · 经 IPC 对上 path→ns 的：${nsByPath.size} 条（清单共 ${Array.isArray(listRows) ? listRows.length : "?"} 行）`);
  ok(nsByPath.size >= 3, `path→ns 映射齐全（${nsByPath.size} 条）——否则种下去的 key 匹配不上，这条审计会空转`);
  const keysOf = (rows) => rows.map((r) => nsByPath.get(r.path) ?? r.path);
  const domKeys = keysOf(groupRows);
  // 反转成一个与默认序明显不同的次序（默认是 created 倒序）
  const seeded = [...domKeys].reverse();
  ok(JSON.stringify(seeded) !== JSON.stringify(domKeys), `预置的次序确实与当前 DOM 不同（否则这条验不出东西）：${JSON.stringify(seeded.map((k) => String(k).slice(0, 8)))}`);
  mkdirSync(projectConfigDir, { recursive: true });
  const orderFile = join(projectConfigDir, "sessions-list.json");
  const existing = existsSync(orderFile) ? JSON.parse(readFileSync(orderFile, "utf-8")) : {};
  writeFileSync(orderFile, JSON.stringify({ ...existing, customOrder: { [group]: seeded } }, null, 2));
  console.log(`  · 已写入 ${orderFile.replace(home, "<HOME>")}: customOrder[${group}] = ${JSON.stringify(seeded.map((k) => String(k).slice(0, 8)))}`);

  await killApp(app);
  app = null;
  await boot(Number(args.port) + 1, "18458");
  await waitForDomIdle(page, { quietMs: 1200, timeoutMs: 20000 }).catch(() => {});
  const afterRestart = (await readOrder()).filter((r) => r.path && !r.path.startsWith("new:") && r.group === group);
  const afterKeys = keysOf(afterRestart);
  console.log(`  · 重启后 DOM 顺序：${JSON.stringify(afterKeys.map((k) => String(k).slice(0, 8)))}`);
  ok(afterKeys.length === seeded.length, `重启后行数一致（${seeded.length} vs ${afterKeys.length}）`);
  ok(JSON.stringify(afterKeys) === JSON.stringify(seeded),
    `② **文件里的顺序 == 重启后 DOM 的顺序**（证明落盘被 applyCustomOrder 真的读回来用上了）`);

  // ---- ③ 损坏域韧性：customOrder 带重复 key 与幽灵 key ----
  //
  // 这段验的是本轮修掉的一个真缺陷：`applyCustomOrder` 原先按 `order` 逐项映射，
  // order 里有重复 key 就会把**同一个会话渲染两行**（items=[a,b] + order=["a","a","b"] → [a,a,b]）。
  // 生产可达：customOrder 落在用户可编辑的 JSON 里，手改或文件损坏就会带重复项。
  console.log("\n── 损坏域：customOrder 带重复 key 与幽灵 key ──");
  const corrupt = { [group]: [seeded[0], seeded[0], "ghost-ns-does-not-exist", seeded[1]] };
  writeFileSync(orderFile, JSON.stringify({ ...existing, customOrder: corrupt }, null, 2));
  console.log(`  · 写入损坏的 customOrder：${JSON.stringify(corrupt[group].map((k) => String(k).slice(0, 10)))}`);
  await killApp(app);
  app = null;
  await boot(Number(args.port) + 2, "18457");
  await waitForDomIdle(page, { quietMs: 1200, timeoutMs: 20000 }).catch(() => {});
  const corruptRows = (await readOrder()).filter((r) => r.path && !r.path.startsWith("new:") && r.group === group);
  const corruptKeys = keysOf(corruptRows);
  console.log(`  · 损坏输入下 DOM：${corruptRows.length} 行，key=${JSON.stringify(corruptKeys.map((k) => String(k).slice(0, 8)))}`);
  ok(corruptRows.length === seeded.length, `**没有重复行**（${corruptRows.length} 行，应为 ${seeded.length}）——重复 key 不该让同一会话渲染两次`);
  ok(new Set(corruptRows.map((r) => r.path)).size === corruptRows.length, "每行的 path 互不相同（无重复渲染）");
  ok(corruptKeys.filter((k) => k === seeded[0]).length === 1, "重复的那个 key 只出现一次");
  ok(!corruptKeys.some((k) => String(k).includes("ghost")), "幽灵 key 不产生行（被跳过，不留空洞）");

  ok(pageErrors.length === 0, `页面零报错（实际 ${pageErrors.length} 条${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ").slice(0, 160) : ""}）`);
} finally {
  if (app) await killApp(app);
}

console.log(`\n════ 审计发现（共 ${findings.length} 条）════`);
for (const f of findings) console.log(`  【${f.severity}】${f.kind}: ${f.detail}`);
console.log(`\n✅ 断言通过 ${passed} 项；审计发现 ${findings.length} 条（H=${findings.filter((f) => f.severity === "H").length}）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
if (findings.some((f) => f.severity === "H")) process.exitCode = 2;
