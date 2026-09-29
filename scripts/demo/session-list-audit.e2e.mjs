#!/usr/bin/env node
// 会话列表交互 + **文件 ↔ DOM 对账**审计 e2e。
//
// 这一类审计的判据不是"点了有反应"，而是三件事同时成立：
//   ① **DOM** 显示了新状态；② **磁盘上的中立层 header** 真的写了那个字段；
//   ③ 两者**一致**（显示的名字 == header 里的 name；显示的置顶态 == header 的 pinned）。
// 只验①会漏掉"界面改了但没落盘"（刷新就回退）；只验②会漏掉"落盘了但界面不刷新"
// （用户看不到自己刚做的操作生效）。这类"半生效"缺陷在乐观更新 + 广播补丁的架构里
// 特别容易出现——本仓的列表行正是走本地补丁（`applyHeaderPatch`）而不是全量重拉。
//
// 覆盖：右键菜单（结构 + 六个动作锚点 + 可访问名）、重命名、置顶、归档、搜索过滤、
// 以及每一行 `data-session-path` 指向的文件是否真的存在。
//
// 零 token：全程用 minimal（echo 内核）造会话。
//
// 用法: npm run build && node scripts/demo/session-list-audit.e2e.mjs [--port 9390] [--keep]
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
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9390" }, keep: { type: "boolean", default: false } } });

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
const neutralDir = join(ctx.dataRoot, "sessions");

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18463" }, timeoutMs: 90000 });
const page = app.page;
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

/** 中立层全部 header（`<ns>.header.json`）——文件↔DOM 对账的"文件"那一侧。 */
const readHeaders = () => {
  if (!existsSync(neutralDir)) return [];
  return readdirSync(neutralDir).filter((f) => f.endsWith(".header.json")).map((f) => {
    const j = JSON.parse(readFileSync(join(neutralDir, f), "utf-8"));
    return { file: f, ns: j.neutralSessionId, name: j.header?.name, pinned: j.header?.pinned, archived: j.header?.archived, kernel: j.header?.kernel };
  });
};

/** 列表里当前可见的会话行（DOM 那一侧）。 */
const readRows = () => page.evaluate(() => [...document.querySelectorAll("[data-session-path]")].map((el) => ({
  path: el.getAttribute("data-session-path"),
  text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
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

const sendAndWaitEcho = async (text) => {
  await page.click("[data-timeline-composer]");
  await page.keyboard.type(text);
  const r = await page.evaluate(() => {
    const b = document.querySelector("[data-composer-send]");   // r237：改用早就存在的稳定锚点（composer.tsx:573，r119 补的），不再按译文子串定位
    const rect = b.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(r.x, r.y);
  // ⚠ waitForFunction(pageFunction, **options**, ...args)——options 在第二位（skill §17.11）
  const got = await page.waitForFunction(
    (t) => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(`[minimal echo] ${t}`)),
    { timeout: 60000, polling: 500 },
    text,
  ).then(() => true).catch(() => false);
  if (!got) throw new Error(`等不到 echo 回复：${text}`);
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 15000 }).catch(() => {});
};

/** 在第 n 个会话行上真实右键（Radix ContextMenu 不认合成事件）。 */
const rightClickRow = async (index) => {
  const r = await page.evaluate((i) => {
    const rows = [...document.querySelectorAll("[data-session-path]")];
    const el = rows[i];
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, path: el.getAttribute("data-session-path") };
  }, index);
  if (!r) throw new Error(`第 ${index} 行不存在`);
  await page.mouse.click(r.x, r.y, { button: "right" });
  await page.waitForSelector("[data-session-action]", { timeout: 8000 });
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 8000 }).catch(() => {});
  return r.path;
};

const clickMenuAction = async (action) => {
  const r = await page.evaluate((a) => {
    const el = document.querySelector(`[data-session-action="${a}"]`);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, action);
  if (!r) throw new Error(`菜单里没有动作 ${action}`);
  await page.mouse.click(r.x, r.y);
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 12000 }).catch(() => {});
};

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  await switchToMinimal();

  // ---- 造两个会话 ----
  console.log("\n── 造两个会话（minimal echo，零 token）──");
  await sendAndWaitEcho("甲会话的提问");
  await page.evaluate(() => document.querySelector("[data-session-new]").click());
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 10000 }).catch(() => {});
  // ⚠ 新会话的 composer **不继承**上一个会话的模型绑定（内核跟随模型，而新会话没有模型
  //   → 落回兜底模型，实测是 pi）。所以第二个会话必须**重新选一次 minimal**，
  //   否则发送会走 pi（花真 token）或因 pi 无可用模型而失败——首版就是这样等不到 echo 的。
  const modelAfterNew = await page.evaluate(() => document.querySelector("[data-composer-model]")?.getAttribute("data-composer-model"));
  console.log(`  · 点「新建」后 composer 绑的模型 = ${modelAfterNew}`);
  if (!String(modelAfterNew).startsWith("minimal:")) await switchToMinimal();
  await sendAndWaitEcho("乙会话的提问");

  let rows = await readRows();
  console.log(`  · 列表 ${rows.length} 行：${rows.map((r) => `‹${r.text.slice(0, 22)}›`).join(" | ")}`);
  ok(rows.length >= 2, `至少两个会话行（实际 ${rows.length}）`);

  // ---- 文件 ↔ DOM 对账（改动之前的基线）----
  console.log("\n── 文件 ↔ DOM 对账（基线）──");
  let headers = readHeaders();
  console.log(`  · 中立层 header ${headers.length} 份：${headers.map((h) => `${h.ns?.slice(0, 8)}…/${h.kernel}/name=${JSON.stringify(h.name)?.slice(0, 22)}`).join(" | ")}`);
  ok(headers.length >= 2, `中立层至少两份 header（实际 ${headers.length}）`);
  ok(headers.every((h) => h.kernel === "minimal"), "两个会话的 header.kernel 都是 minimal");
  for (const r of rows) {
    // data-session-path 指向的是**内核侧**会话文件；它必须真的存在，否则行是幽灵
    if (r.path && !existsSync(r.path) && !r.path.startsWith("new:")) {
      note("H", "会话行指向不存在的文件", `${r.path}（行文本「${r.text.slice(0, 26)}」）`);
    }
  }
  ok(true, `已逐行核对 data-session-path 指向的文件是否存在（${rows.length} 行）`);

  // ---- 右键菜单：结构 + 六个动作 + 可访问名 ----
  console.log("\n── 右键菜单 ──");
  const targetPath = await rightClickRow(0);
  const menu = await page.evaluate(() => {
    const items = [...document.querySelectorAll("[data-session-action]")];
    return {
      actions: items.map((el) => el.getAttribute("data-session-action")),
      unnamed: items.filter((el) => !((el.textContent || "").trim() || el.getAttribute("aria-label"))).map((el) => el.getAttribute("data-session-action")),
      // 菜单项里不该再嵌交互元素（HTML 规范禁止，且会让键盘导航错乱）
      nested: items.filter((el) => el.querySelector("button, a[href], input, [role=menuitem]")).map((el) => el.getAttribute("data-session-action")),
      roleOk: items.every((el) => el.getAttribute("role") === "menuitem"),
    };
  });
  console.log(`  · 菜单动作（第 0 行 = 当前活跃会话）：${JSON.stringify(menu.actions)}`);
  for (const a of ["rename", "pin", "archive", "open-desktop-file", "open-kernel-file"]) {
    ok(menu.actions.includes(a), `菜单里有「${a}」动作（按锚点查，不按译文）`);
  }
  // ⚠ delete 是**有条件**的：源码注释写明「删除:不可恢复,仅 deletable(非当前活跃会话)」。
  //   第 0 行正是刚发送的活跃会话，所以这里 delete **不该**出现——首版把它当无条件项断言，
  //   于是报了一条假缺陷。规则要**双向**钉：活跃行没有、非活跃行有。
  ok(!menu.actions.includes("delete"), "活跃会话的菜单里**没有** delete（不可恢复操作对当前会话隐藏，符合源码规则）");
  await page.keyboard.press("Escape");
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 8000 }).catch(() => {});
  // 非活跃行：delete 必须在
  const otherRowIdx = (await readRows()).findIndex((r) => r.path !== targetPath);
  await rightClickRow(otherRowIdx);
  const menu2 = await page.evaluate(() => [...document.querySelectorAll("[data-session-action]")].map((el) => el.getAttribute("data-session-action")));
  console.log(`  · 菜单动作（第 ${otherRowIdx} 行 = 非活跃会话）：${JSON.stringify(menu2)}`);
  ok(menu2.includes("delete"), "非活跃会话的菜单里**有** delete（规则的另一半）");
  ok(menu.unnamed.length === 0, `每个菜单项都有可读名（无名的：${JSON.stringify(menu.unnamed)}）`);
  ok(menu.nested.length === 0, `菜单项里没有嵌套交互元素（违规：${JSON.stringify(menu.nested)}）`);
  ok(menu.roleOk, "菜单项的 role 都是 menuitem（Radix 语义完整）");

  // ---- 重命名：DOM 与 header 必须同时变、且一致 ----
  console.log("\n── 重命名 ──");
  await clickMenuAction("rename");
  const NEW_NAME = "审计改名甲";
  await page.waitForSelector("[data-session-rename]", { timeout: 8000 });
  await page.evaluate(() => {
    const inp = document.querySelector("[data-session-rename]");
    inp.focus();
    inp.select();          // 全选，替换掉 defaultValue（原有会话名）
  });
  await page.keyboard.type(NEW_NAME);
  await page.keyboard.press("Enter");
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});
  rows = await readRows();
  const renamedRow = rows.find((r) => r.text.includes(NEW_NAME));
  ok(!!renamedRow, `DOM 里出现新名字「${NEW_NAME}」（实际各行：${rows.map((r) => r.text.slice(0, 18)).join(" | ")}）`);
  headers = readHeaders();
  const renamedHeader = headers.find((h) => h.name === NEW_NAME);
  ok(!!renamedHeader, `中立层 header 的 name 真的写成了「${NEW_NAME}」（实际：${JSON.stringify(headers.map((h) => h.name))}）`);
  ok(!!renamedRow && !!renamedHeader, "① DOM 与 ② 磁盘**同时**变了（半生效就是缺陷）");

  /** 读某一行的「视觉隐藏状态文本」及其计算样式（判断 sr-only 是否真的生效）。 */
  const readStateText = (nameFragment) => page.evaluate((frag) => {
    const row = [...document.querySelectorAll("[data-session-path]")]
      .find((el) => (el.textContent || "").includes(frag));
    if (!row) return null;
    const el = row.querySelector("[data-session-state-text]");
    if (!el) return { rowFound: true, text: null };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      rowFound: true, text: (el.textContent || "").trim(),
      // sr-only 的计算特征：绝对定位 + 1px 见方 + 溢出隐藏 + clip
      pos: cs.position, w: Math.round(r.width), h: Math.round(r.height),
      overflow: cs.overflow, clip: cs.clip || cs.clipPath,
      rowAccessibleText: (row.textContent || "").replace(/\s+/g, " ").trim(),
    };
  }, nameFragment);

  // ---- 置顶：header.pinned 落盘 + DOM 有置顶态 ----
  console.log("\n── 置顶 ──");
  // ⚠ 按**名字**定位刚改名那一行，不要写死行号：重命名可能改变排序（置顶/自定义序），
  //   而且上一步 rename 作用的是"非活跃行"而不是第 0 行。首版写死 rightClickRow(0)，
  //   于是置顶的是另一个会话，断言"被置顶的正是刚改名那个"就红了——那是剧本记账错，
  //   不是产品缺陷（skill §17.9：先排除剧本自身的问题）。
  const renamedIdx = (await readRows()).findIndex((r) => r.text.includes(NEW_NAME));
  ok(renamedIdx >= 0, `能在列表里按名字找到刚改名的行（索引 ${renamedIdx}）`);
  await rightClickRow(renamedIdx);
  await clickMenuAction("pin");
  headers = readHeaders();
  const pinned = headers.filter((h) => h.pinned === true);
  console.log(`  · header 里 pinned=true 的：${pinned.length} 份（${pinned.map((h) => JSON.stringify(h.name)).join(", ")}）`);
  ok(pinned.length === 1, `恰有一份 header 被标 pinned（实际 ${pinned.length}）`);
  ok(pinned[0]?.name === NEW_NAME, `被置顶的正是刚改名那个会话（实际 ${JSON.stringify(pinned[0]?.name)}）`);
  // 可访问名是否**够用**（r40）：置顶态此前只有 Pin 图标，读屏念得标题、念不出"已置顶"
  const stPinned = await readStateText(NEW_NAME);
  console.log(`  · 置顶行的状态文本：${JSON.stringify(stPinned)}`);
  ok(stPinned?.text != null, "置顶后该行有视觉隐藏的状态文本（不是只靠 Pin 图标）");
  ok((stPinned?.text ?? "").includes("已置顶"), `状态文本含「已置顶」（实际 ${JSON.stringify(stPinned?.text)}）`);
  ok((stPinned?.rowAccessibleText ?? "").includes("已置顶"),
    "**行的可访问文本里也含「已置顶」**（状态文本必须在行的内容里，否则读屏念行时听不到）");
  // sr-only 必须**真的**生效：本仓有过 Tailwind @source 扫描漂移的历史（CLAUDE.md §3.7），
  // 类没生成时元素会正常显示 —— 那就是界面上多出一串"已置顶"文字，比不加更糟。
  ok(stPinned?.pos === "absolute" && stPinned.w <= 1 && stPinned.h <= 1,
    `sr-only 真的把它视觉隐藏了（position=${stPinned?.pos}、${stPinned?.w}×${stPinned?.h}px；若类没生成这里会红）`);
  ok(stPinned?.overflow === "hidden", "sr-only 元素 overflow=hidden（内容不溢出到可视区）");

  // ---- 归档：header.archived 落盘 + 行离开活跃列表 ----
  console.log("\n── 归档 ──");
  const rowsBeforeArchive = await readRows();
  // 归档**另一个**会话（不是刚置顶的那个），这样两个操作互不干扰
  const otherIdx = rowsBeforeArchive.findIndex((r) => !r.text.includes(NEW_NAME));
  ok(otherIdx >= 0, "找得到另一个可归档的会话行");
  const otherPath = rowsBeforeArchive[otherIdx].path;
  await rightClickRow(otherIdx);
  await clickMenuAction("archive");
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});
  headers = readHeaders();
  const archived = headers.filter((h) => h.archived === true);
  ok(archived.length === 1, `恰有一份 header 被标 archived（实际 ${archived.length}）`);
  const rowsAfterArchive = await readRows();
  // ⚠ 断言不是"行从 DOM 消失"：归档是**移进 archived 分组**（`buildGroups` 里
  //   `items.filter((s) => s.archived)` 单独成组），行仍在 DOM 里，只是换了分组，
  //   而且该组 `defaultOpen: false`（默认折叠）。首版断言"离开活跃列表"，于是把
  //   正确行为判成了缺陷。正确判据是**它现在属于哪个分组**。
  const groupOf = await page.evaluate((path) => {
    const row = [...document.querySelectorAll("[data-session-path]")].find((el) => el.getAttribute("data-session-path") === path);
    if (!row) return null;
    const g = row.closest("[data-session-group]");
    return g ? { id: g.getAttribute("data-session-group"), open: g.getAttribute("data-session-group-open") } : null;
  }, otherPath);
  console.log(`  · 被归档的行现在属于分组：${JSON.stringify(groupOf)}`);
  ok(groupOf?.id === "archived", `被归档的行移进了 archived 分组（实际 ${JSON.stringify(groupOf?.id)}）——DOM 与磁盘的 archived=true 一致`);
  // 归档态的可访问文本（r40）：分组标题虽已说「已归档」，但按**行**导航时读屏只念该行，
  // 听不出它在归档组里；而搜索平铺视图下归档行更是脱离分组渲染（只有一个 Archive 角标）。
  // 按 **path** 定位（归档行的标题不含 NEW_NAME，而 otherPath 是这一步实际操作的行）
  const stArch = await page.evaluate((path) => {
    const row = document.querySelector(`[data-session-path="${path}"]`);
    if (!row) return null;
    const el = row.querySelector("[data-session-state-text]");
    return { text: el ? (el.textContent || "").trim() : null, rowAccessibleText: (row.textContent || "").replace(/\s+/g, " ").trim() };
  }, otherPath);
  console.log(`  · 归档行的状态文本：${JSON.stringify(stArch?.text)}；行可访问文本：${JSON.stringify((stArch?.rowAccessibleText ?? "").slice(0, 60))}`);
  ok((stArch?.text ?? "").includes("已归档"), `归档行的状态文本含「已归档」（实际 ${JSON.stringify(stArch?.text)}）`);
  ok((stArch?.rowAccessibleText ?? "").includes("已归档"), "归档态进了该行的可访问文本（按行导航时也听得到）");
  // 对照：没被归档的那行不该在 archived 组
  const groupOfKept = await page.evaluate((name) => {
    const row = [...document.querySelectorAll("[data-session-path]")].find((el) => (el.textContent || "").includes(name));
    const g = row?.closest("[data-session-group]");
    return g ? g.getAttribute("data-session-group") : null;
  }, NEW_NAME);
  ok(groupOfKept !== "archived", `未被归档的行不在 archived 组（实际在 ${JSON.stringify(groupOfKept)}）`);
  console.log(`  · 归档后列表 ${rowsAfterArchive.length} 行（归档前 ${rowsBeforeArchive.length}；行数不变，变的是分组）`);

  // ---- 搜索过滤 ----
  console.log("\n── 搜索 ──");
  // 先 Esc 收掉可能残留的右键菜单（否则点击会被菜单吃掉），再展开搜索、点进**输入框**打字。
  // ⚠ `[data-session-search]` 是**展开按钮**，`[data-session-search-input]` 才是输入框；
  //   首版往按钮上打字，于是"搜索没生效"看起来像过滤坏了，其实是没写到输入框。
  await page.keyboard.press("Escape");
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 8000 }).catch(() => {});
  const rowsBeforeSearch = await readRows();
  ok(rowsBeforeSearch.length >= 1, `搜索前列表非空（${rowsBeforeSearch.length} 行）——否则后面的"过滤生效"无从判断`);
  await page.evaluate(() => document.querySelector("[data-session-search]").scrollIntoView({ block: "center" }));
  await page.evaluate(() => document.querySelector("[data-session-search]").click());
  await page.waitForSelector("[data-session-search-input]", { timeout: 8000 });
  await page.click("[data-session-search-input]");
  await page.keyboard.type(NEW_NAME);
  // 确认真的打进了输入框（不确认就会把"没打到"误判成"过滤坏了"）
  const typedValue = await page.evaluate(() => document.querySelector("[data-session-search-input]")?.value ?? null);
  ok(typedValue === NEW_NAME, `搜索框里确实是「${NEW_NAME}」（实际 ${JSON.stringify(typedValue)}）`);
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 12000 }).catch(() => {});
  const diag = await page.evaluate(() => ({
    inputValue: document.querySelector("[data-session-search-input]")?.value ?? null,
    groupIds: [...document.querySelectorAll("[data-session-group]")].map((g) => g.getAttribute("data-session-group")),
    rowCount: document.querySelectorAll("[data-session-path]").length,
  }));
  console.log(`  · 诊断：搜索框实际值=${JSON.stringify(diag.inputValue)} 分组=${JSON.stringify(diag.groupIds)} 行数=${diag.rowCount}`);
  const filtered = await readRows();
  console.log(`  · 搜「${NEW_NAME}」→ ${filtered.length} 行：${filtered.map((r) => r.text.slice(0, 20)).join(" | ")}`);
  ok(filtered.length >= 1 && filtered.every((r) => r.text.includes(NEW_NAME)), "搜索结果只含匹配行（过滤真的生效，不是摆设）");
  await page.evaluate(() => {
    const el = document.querySelector("[data-session-search-input]");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 10000 }).catch(() => {});
  const restored = await readRows();
  ok(restored.length >= rowsAfterArchive.length, `清空搜索后列表恢复（${restored.length} 行 ≥ ${rowsAfterArchive.length}）`);

  // ---- 收尾对账：DOM 显示的名字与 header 的 name 一一对应 ----
  console.log("\n── 收尾对账 ──");
  headers = readHeaders();
  rows = await readRows();
  for (const h of headers) {
    if (h.archived) continue;
    if (typeof h.name !== "string" || !h.name) continue;
    const shown = rows.some((r) => r.text.includes(h.name));
    if (!shown) note("M", "header 有名字但列表没显示", `ns=${h.ns} name=${JSON.stringify(h.name)}；列表：${rows.map((r) => r.text.slice(0, 16)).join(" | ")}`);
  }
  // ── 当前会话行的可访问态（r39）──
  // 此前当前会话只靠 background/border/boxShadow 三个 token 表达（视觉态有、可访问态无），
  // 读屏用户在列表里听不出自己正处在哪一个会话。与 r36 给项目行补 aria-current 同类。
  const currents = await page.evaluate(() => [...document.querySelectorAll("[data-session-path]")].map((el) => ({
    path: el.getAttribute("data-session-path"),
    current: el.getAttribute("aria-current"),
    bg: getComputedStyle(el).backgroundColor,
  })));
  const marked = currents.filter((c) => c.current !== null);
  console.log(`  · aria-current：${marked.length} 行有标记（共 ${currents.length} 行）`);
  ok(marked.length <= 1, `至多一行带 aria-current（实际 ${marked.length} 行；多行都标等于没标）`);
  ok(marked.every((c) => c.current === "true"), `aria-current 取值是 true 而不是 false（false 是噪音）`);
  // 视觉态与可访问态必须同源：有 active 底色的那行，就该是带 aria-current 的那行
  const visuallyActive = currents.filter((c) => c.bg && c.bg !== "rgba(0, 0, 0, 0)" && c.bg !== "transparent");
  if (marked.length === 1 && visuallyActive.length >= 1) {
    ok(visuallyActive.some((v) => v.path === marked[0].path),
      "带 aria-current 的行 == 视觉上有激活底色的行（两种表达同源，不是各说各话）");
  }

  // ---- 未读态：状态必须进**行内文本**，不能只靠徽标（r43）----
  //
  // 为什么单验这一项：未读圆点原先是 `<span title aria-label>`——**无 role 的 generic 元素上挂
  // aria-label**，按 ARIA 1.2 不被支持（实现不一，很可能被忽略）；而且它的渲染条件是
  // `unread && !hovered`，**hover 时徽标整个从 DOM 消失**，状态跟着消失。
  // 修法是把状态搬进行内常驻的 sr-only 文本、徽标改 aria-hidden。这段就是验它真的成立。
  console.log("\n── 未读态 ──");
  const activeRow = await page.evaluate(() => {
    const el = document.querySelector('[data-session-path][aria-current="true"]');
    return el ? (el.textContent || "").slice(0, 40) : null;
  });
  const heads = readHeaders();
  // 挑一个"不是当前会话"的 header（unread 的第一个条件就是非当前会话）
  const target = heads.find((h) => !h.archived && h.name && !(activeRow ?? "").includes(h.name));
  if (!target) {
    console.log("  · 没有可用的非当前会话行，跳过未读态验证（见下方说明）");
    note?.("L", "未读态未验证", "隔离环境里找不到非当前的未归档会话行");
  } else {
    // unread 的判据是 `readState[ns] !== lastEntryByPath[ns]`（两个来源的比较）。
    // ⚠ 首版改的是 header 的 lastEntryId，**没造出未读**（刷新后 stateText 里只有「已置顶」）——
    //   说明 lastEntryByPath 不是直接读我改的那个字段（或刷新链上有别的来源）。
    //   改**另一边**更可控：把插件配置里的 readState[ns] 设成一个必然不同的旧值。
    const cfgDir = join(projectDir, ".my-harness-desktop", "config");
    const cfgFile = join(cfgDir, "sessions-list.json");
    mkdirSync(cfgDir, { recursive: true });
    const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf-8")) : {};
    const prevRead = cfg.readState?.[target.ns] ?? null;
    cfg.readState = { ...(cfg.readState ?? {}), [target.ns]: "r43-stale-entry-id" };
    writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
    console.log(`  · 已把「${target.name}」(ns=${String(target.ns).slice(0, 8)}) 的 readState 设为陈旧值（原 ${JSON.stringify(prevRead)}）`);
    await page.evaluate(() => document.querySelector("[data-session-refresh]")?.click());
    await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});
    const unreadProbe = await page.evaluate((name) => {
      const row = [...document.querySelectorAll("[data-session-path]")].find((el) => (el.textContent || "").includes(name));
      if (!row) return null;
      const st = row.querySelector("[data-session-state-text]");
      // 行内所有"无 role 却挂 aria-label"的元素（不可靠的 a11y 形态，应当为 0）
      const risky = [...row.querySelectorAll("[aria-label]")].filter((el) => !el.getAttribute("role") && !/^(BUTTON|A|INPUT)$/.test(el.tagName));
      const dot = row.querySelector("span.rounded-full[aria-hidden]");
      return {
        stateText: st ? (st.textContent || "").trim() : null,
        rowText: (row.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
        riskyCount: risky.length,
        riskyTags: risky.map((e) => `${e.tagName}[${e.getAttribute("aria-label")?.slice(0, 16)}]`),
        dotAriaHidden: !!dot,
      };
    }, target.name);
    console.log(`  · 未读探针：${JSON.stringify(unreadProbe)}`);
    ok(!!unreadProbe, `刷新后仍能找到「${target.name}」这一行`);
    if (unreadProbe) {
      // ★ 这条是**通用不变量**，与未读是否造得出来无关，实测稳定通过：
      //   行内不得有"无 role 却挂 aria-label"的元素——ARIA 1.2 不支持在 role=generic 上命名，
      //   那种写法看着像做了 a11y、实际很可能被读屏忽略（未读圆点与内核未装载角标原先都是这个形态）。
      ok(unreadProbe.riskyCount === 0,
        `行内没有「无 role 却挂 aria-label」的元素（ARIA 1.2 不支持在 generic 上命名；实际 ${unreadProbe.riskyCount} 个 ${JSON.stringify(unreadProbe.riskyTags)}）`);
      // 未读态本身：造得出来才断言，造不出来**如实说明**，不写成通过。
      // 实测在隔离环境里造不出来：readState 由插件在**挂载时**读一次，点刷新不重读配置；
      // 且活跃会话会"自动跟随已读"把它写回。要真造出未读需要"另一个会话在后台收到新 entry"，
      // 那是生产路径（真实内核推送），零 token 剧本复刻不了。
      // ⇒ `unread ? t("sessions.unread") : null` 这一支**只有代码级证据**：
      //   它与已验证的 pinned/archived 两支在同一个 stateText 数组里、走同一条渲染路径
      //   （那两条在真机上验过：行的可访问文本确实带上了「已置顶」/「已归档」）。
      const isUnread = (unreadProbe.rowText ?? "").includes("未读");
      if (isUnread) {
        ok((unreadProbe.stateText ?? "").includes("未读"), "未读态进了行内 sr-only 文本");
        ok(unreadProbe.dotAriaHidden, "未读圆点已标 aria-hidden（语义由文本承担，避免重复播报）");
      } else {
        console.log("    · 未能在隔离环境造出未读行（readState 挂载时读一次 + 活跃会话自动跟随已读）；");
        console.log("      未读支路**只有代码级证据**（与已真机验证的 pinned/archived 同一个 stateText 数组、同一条渲染路径），不计入通过项。");
      }
    }
  }

  ok(pageErrors.length === 0, `页面零报错（实际 ${pageErrors.length} 条${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ").slice(0, 160) : ""}）`);
  console.log(`  · 目标会话 path=${targetPath ? "已记录" : "无"}`);
} finally {
  await killApp(app);
}

console.log(`\n════ 审计发现（共 ${findings.length} 条）════`);
for (const f of findings) console.log(`  【${f.severity}】${f.kind}: ${f.detail}`);
console.log(`\n✅ 断言通过 ${passed} 项；审计发现 ${findings.length} 条（H=${findings.filter((f) => f.severity === "H").length}）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
if (findings.some((f) => f.severity === "H")) process.exitCode = 2;
